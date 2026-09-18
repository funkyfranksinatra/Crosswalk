#!/usr/bin/env bash
# Stop the database we started (Docker or Homebrew). Data is kept.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
case "$(db_mode)" in
  docker) docker_running && docker compose down && ok "Docker Postgres stopped (data kept in the crosswalk-pgdata volume)" ;;
  brew) brew services stop postgresql@17 && ok "Homebrew Postgres stopped" ;;
  external) ok "External database — nothing to stop" ;;
esac
