package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"starrychat/backend/trigger/config"
	"starrychat/backend/trigger/delivery"
	"starrychat/backend/trigger/handler"
	"starrychat/backend/trigger/repository"
	"starrychat/backend/trigger/service"
)

func main() {
	defaultConfig := os.Getenv("TRIGGER_CONFIG")
	if defaultConfig == "" {
		defaultConfig = "localdeploy/trigger/config.json"
	}
	path := flag.String("config", defaultConfig, "private Trigger configuration file")
	flag.Parse()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	err := run(ctx, *path)
	stop()
	if err != nil {
		fmt.Fprintln(os.Stderr, "Trigger 未就绪："+err.Error())
		os.Exit(1)
	}
}

func run(ctx context.Context, path string) error {
	c, err := config.Load(path)
	if err != nil {
		return fmt.Errorf("%s；未启动 HTTP 监听。", err)
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
	listener, err := net.Listen("tcp", c.Address)
	if err != nil {
		return errors.New("HTTP 地址无法监听，请检查配置和端口占用。")
	}
	var deliverer service.Deliverer
	if c.AgentDeliveryURL != "" {
		deliverer = delivery.NewHTTP(c.AgentDeliveryURL)
	}
	server := &http.Server{
		Handler: handler.New(service.New(store, deliverer)), ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout: 15 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second,
	}
	done := make(chan error, 1)
	go func() { done <- server.Serve(listener) }()
	fmt.Fprintf(os.Stdout, "Trigger 已就绪：http://%s\n", listener.Addr())
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
