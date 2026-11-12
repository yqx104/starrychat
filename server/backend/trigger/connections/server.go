package connections

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"starrychat/backend/trigger/imclient"
	"starrychat/backend/trigger/model"
	"starrychat/backend/trigger/repository"
)

// Server owns one live connection per Agent in the single Trigger process.
type Server struct {
	store  *repository.Repository
	im     *imclient.Client
	mu     sync.Mutex
	active map[string]*websocket.Conn
	closed bool
	wg     sync.WaitGroup
}

func New(store *repository.Repository, im *imclient.Client) *Server {
	return &Server{store: store, im: im, active: make(map[string]*websocket.Conn)}
}

func (s *Server) authenticate(r *http.Request) (imclient.Identity, int) {
	parts := strings.Fields(r.Header.Get("Authorization"))
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
		return imclient.Identity{}, http.StatusUnauthorized
	}
	who, err := s.im.Authenticate(r.Context(), parts[1])
	switch {
	case errors.Is(err, imclient.ErrUnauthorized):
		return who, http.StatusUnauthorized
	case errors.Is(err, imclient.ErrForbidden):
		return who, http.StatusForbidden
	case err != nil:
		return who, http.StatusServiceUnavailable
	}
	return who, 0
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	who, status := s.authenticate(r)
	if status != 0 {
		http.Error(w, http.StatusText(status), status)
		return
	}
	if err := s.store.RegisterAgent(r.Context(), who.AgentID, time.Now().UnixMilli()); err != nil {
		http.Error(w, "Registration unavailable", 503)
		return
	}
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		http.Error(w, "Shutting down", 503)
		return
	}
	if _, exists := s.active[who.AgentID]; exists {
		s.mu.Unlock()
		http.Error(w, "Agent already connected", 409)
		return
	}
	upgrader := websocket.Upgrader{HandshakeTimeout: 5 * time.Second}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		s.mu.Unlock()
		return
	}
	s.active[who.AgentID] = conn
	s.wg.Add(1)
	s.mu.Unlock()
	defer func() {
		conn.Close()
		s.mu.Lock()
		delete(s.active, who.AgentID)
		s.mu.Unlock()
		s.wg.Done()
	}()
	s.serve(r.Context(), conn, who)
}

func (s *Server) serve(ctx context.Context, conn *websocket.Conn, who imclient.Identity) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	write := func(value any) error {
		conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
		return conn.WriteJSON(value)
	}
	if write(map[string]any{"type": "ready", "agent_id": who.AgentID, "token": who.Token, "expires_at": who.ExpiresAt}) != nil {
		return
	}
	conn.SetReadLimit(4096)
	conn.SetReadDeadline(time.Now().Add(45 * time.Second))
	conn.SetPongHandler(func(string) error { return conn.SetReadDeadline(time.Now().Add(45 * time.Second)) })
	acks := make(chan string, 1)
	go func() {
		defer cancel()
		for {
			var ack struct {
				Type      string `json:"type"`
				MessageID string `json:"message_id"`
			}
			if conn.ReadJSON(&ack) != nil {
				return
			}
			if ack.Type != "ack" {
				return
			}
			select {
			case acks <- ack.MessageID:
			case <-ctx.Done():
				return
			}
		}
	}()
	poll := time.NewTicker(time.Second)
	defer poll.Stop()
	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()
	expires := time.NewTimer(time.Until(time.UnixMilli(who.ExpiresAt)))
	defer expires.Stop()
	type pendingDelivery struct {
		item   model.Delivery
		sentAt time.Time
	}
	// Each channel has one in-flight delivery; all WS writes stay in this loop.
	pendingByChannel := make(map[string]*pendingDelivery)
	sendChannel := func(channelID string) error {
		pending := pendingByChannel[channelID]
		if pending == nil {
			item, err := s.store.NextDelivery(ctx, who.AgentID, channelID)
			if errors.Is(err, sql.ErrNoRows) {
				return nil
			}
			if err != nil {
				return err
			}
			pending = &pendingDelivery{item: item}
			pendingByChannel[channelID] = pending
		} else if time.Since(pending.sentAt) < 5*time.Second {
			return nil
		}
		err := write(struct {
			Type string `json:"type"`
			model.Delivery
		}{"delivery", pending.item})
		pending.sentAt = time.Now()
		return err
	}
	send := func() error {
		channels, err := s.store.PendingChannels(ctx, who.AgentID)
		if err != nil {
			return err
		}
		for _, channelID := range channels {
			if err := sendChannel(channelID); err != nil {
				return err
			}
		}
		return nil
	}
	if send() != nil {
		return
	}
	for {
		select {
		case <-ctx.Done():
			return
		case <-expires.C:
			conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(4001, "Authentication expired"), time.Now().Add(time.Second))
			return
		case <-heartbeat.C:
			if conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(5*time.Second)) != nil {
				return
			}
		case <-poll.C:
			if send() != nil {
				return
			}
		case id := <-acks:
			for channelID, pending := range pendingByChannel {
				if id != pending.item.Message.MessageID {
					continue
				}
				if s.store.Acknowledge(ctx, who.AgentID, id) != nil {
					return
				}
				delete(pendingByChannel, channelID)
				if sendChannel(channelID) != nil {
					return
				}
				break
			}
		}
	}
}

func (s *Server) Close() {
	s.mu.Lock()
	s.closed = true
	for _, conn := range s.active {
		conn.Close()
	}
	s.mu.Unlock()
	s.wg.Wait()
}
