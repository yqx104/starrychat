package config

import (
	"encoding/json"
	"errors"
	"os"
)

type Config struct {
	MySQLDSN         string `json:"mysql_dsn"`
	Address          string `json:"address"`
	AgentDeliveryURL string `json:"agent_delivery_url"`
}

func Load(path string) (Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Config{}, errors.New("unable to read TRIGGER_CONFIG")
	}
	var c Config
	if err := json.Unmarshal(data, &c); err != nil {
		return Config{}, errors.New("invalid TRIGGER_CONFIG JSON")
	}
	if c.MySQLDSN == "" {
		return Config{}, errors.New("TRIGGER_CONFIG requires mysql_dsn")
	}
	if c.Address == "" {
		c.Address = "127.0.0.1:4182"
	}
	return c, nil
}
