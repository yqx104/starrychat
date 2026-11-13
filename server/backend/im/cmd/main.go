package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"starrychat/backend/im/common/auth"
	"starrychat/backend/im/config"
	"starrychat/backend/im/handler"
	"starrychat/backend/im/repository"
	"starrychat/backend/im/service"
	"starrychat/backend/im/triggerclient"
)

func main() {
	defaultConfig := os.Getenv("IM_CONFIG")
	if defaultConfig == "" {
		defaultConfig = "localdeploy/im/config.json"
	}
	path := flag.String("config", defaultConfig, "private IM configuration file")
	bind := flag.Bool("bind-human-account", false, "bind the existing human using username/password JSON on stdin; never starts HTTP")
	flag.Parse()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	err := run(ctx, *path, *bind)
	stop()
	if err != nil {
		fmt.Fprintln(os.Stderr, "IM 未就绪："+err.Error())
		os.Exit(1)
	}
}

func run(ctx context.Context, path string, bind bool) error {
	c, err := config.Load(path)
	if err != nil {
		return fmt.Errorf("%s；未启动 HTTP 监听。", err)
	}
	key, err := config.LoadOrCreateKey(c.SigningKeyFile)
	if err != nil {
		return err
	}
	startup, cancel := context.WithTimeout(ctx, 10*time.Second)
	store, err := repository.Open(startup, c.MySQLDSN)
	if err != nil {
		cancel()
		return errors.New("MySQL 连接失败，请检查私有配置；未启动 HTTP 监听。")
	}
	defer store.Close()
	err = store.CheckSchema(startup)
	cancel()
	if err != nil {
		return errors.New("MySQL 表结构不符合 sql/schema.sql；未启动 HTTP 监听。")
	}
	s := service.New(store, triggerclient.New(c.TriggerBaseURL))
	if bind {
		return bindHuman(ctx, s)
	}
	tokens, err := auth.NewTokens(key, c.Issuer, c.Audience, nil)
	if err != nil {
		return err
	}
	api := handler.NewAPI(s, s, tokens, handler.APIOptions{InsecureLocalHTTP: c.InsecureLocalHTTP})
	listener, err := net.Listen("tcp", c.Address)
	if err != nil {
		return errors.New("HTTP 地址无法监听，请检查配置和端口占用。")
	}
	server := &http.Server{Handler: api, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 << 10}
	syncContext, stopSync := context.WithCancel(ctx)
	syncDone := make(chan struct{})
	go func() {
		defer close(syncDone)
		s.RunTriggerSync(syncContext)
	}()
	defer func() { stopSync(); <-syncDone }()
	done := make(chan error, 1)
	go func() { done <- server.Serve(listener) }()
	fmt.Fprintf(os.Stdout, "IM 已就绪：http://%s\n", listener.Addr())
	select {
	case err := <-done:
		if !errors.Is(err, http.ErrServerClosed) {
			return errors.New("HTTP 服务意外停止。")
		}
	case <-ctx.Done():
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdown); err != nil {
			_ = server.Close()
		}
		<-done
	}
	return nil
}

func bindHuman(ctx context.Context, s *service.Service) error {
	var input struct {
		ParticipantID string `json:"participant_id"`
		Username      string `json:"username"`
		Password      string `json:"password"`
	}
	decoder := json.NewDecoder(io.LimitReader(os.Stdin, 16<<10))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		return errors.New("绑定需要从标准输入读取 username/password JSON。")
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return errors.New("绑定输入必须只有一个 JSON 对象。")
	}
	participant, err := s.BindHumanAccount(ctx, input.ParticipantID, input.Username, input.Password)
	if err != nil {
		return errors.New("真人账号绑定失败：检查账号格式、现有真人及是否已经绑定；数据库错误不会输出凭据。")
	}
	fmt.Fprintf(os.Stdout, "已为既有真人 participant_id=%s 绑定账号。\n", participant.ParticipantID)
	return nil
}
