#!/bin/bash

# ====================================================================
# VedaAI - Docker Management Script
# ====================================================================

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

print_status()  { echo -e "${GREEN}[✓]${NC} $1"; }
print_warning() { echo -e "${YELLOW}[!]${NC} $1"; }
print_error()   { echo -e "${RED}[✗]${NC} $1"; }
print_header()  { echo -e "\n${BLUE}━━━ $1 ━━━${NC}"; }
print_info()    { echo -e "${CYAN}[i]${NC} $1"; }

export DOCKER_BUILDKIT=1
export COMPOSE_DOCKER_CLI_BUILD=1

# ====================================================================
# BUILD COMMANDS
# ====================================================================

init() {
    print_header "FULL BUILD + START"
    print_info "Use this for first-time setup or when requirements change"

    if [ ! -f "backend/.env" ]; then
        print_error "backend/.env not found"
        print_info "Copy backend/.env.example to backend/.env and configure it"
        exit 1
    fi

    print_status "Pruning Docker system to free memory..."
    docker system prune -f

    start_time=$(date +%s)

    print_status "Building all images (parallel)..."
    docker compose build --parallel

    print_status "Starting all services..."
    docker compose up -d

    end_time=$(date +%s)
    print_header "INIT COMPLETED in $((end_time - start_time))s"
    show_urls
    print_info "Check logs: ./vedaai.sh logs"
}

build() {
    print_header "BUILD IMAGES (no start)"
    print_warning "Use this when requirements.txt or package.json changes"

    docker system prune -f

    start_time=$(date +%s)
    docker compose build --no-cache --parallel
    end_time=$(date +%s)

    print_header "BUILD COMPLETED in $((end_time - start_time))s"
    print_info "Next: ./vedaai.sh start"
}

rebuild() {
    print_header "QUICK REBUILD - Code Changes Only"

    start_time=$(date +%s)

    docker compose down --remove-orphans
    docker compose build --parallel
    docker compose up -d

    end_time=$(date +%s)
    print_header "REBUILD COMPLETED in $((end_time - start_time))s"
    show_urls
}

reload() {
    print_header "HOT RELOAD - Restart with Latest Containers"
    start_time=$(date +%s)
    docker compose up -d --build
    end_time=$(date +%s)
    print_status "Reloaded in $((end_time - start_time))s"
    show_urls
}

# ====================================================================
# LIFECYCLE COMMANDS
# ====================================================================

start() {
    print_status "Starting all services..."
    docker compose up -d
    print_status "Services started"
    show_urls
}

stop() {
    print_status "Stopping all services..."
    docker compose down
    print_status "Services stopped"
}

restart() {
    print_header "RESTARTING SERVICES"
    stop
    start
}

# ====================================================================
# MONITORING COMMANDS
# ====================================================================

logs() {
    local service="$2"
    if [ -z "$service" ]; then
        print_info "Showing logs for all services (Ctrl+C to exit)"
        docker compose logs -f
    else
        case "$service" in
            api|worker|frontend|redis)
                docker compose logs -f "$service"
                ;;
            *)
                print_error "Unknown service: $service"
                print_info "Valid services: api, worker, frontend, redis"
                exit 1
                ;;
        esac
    fi
}

status() {
    print_header "SERVICE STATUS"
    docker compose ps
    echo ""
    print_header "RESOURCE USAGE"
    docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.NetIO}}"
}

health() {
    print_header "HEALTH CHECKS"

    echo -n "API:      "
    if curl -sf http://localhost:8000/health > /dev/null 2>&1; then
        print_status "Healthy"
    else
        print_error "Unhealthy / not running"
    fi

    echo -n "Frontend: "
    if curl -sf http://localhost:3000 > /dev/null 2>&1; then
        print_status "Healthy"
    else
        print_error "Unhealthy / not running"
    fi

    echo -n "Redis:    "
    if docker compose exec -T redis redis-cli ping > /dev/null 2>&1; then
        print_status "Healthy"
    else
        print_error "Unhealthy / not running"
    fi
}

metrics() {
    print_header "RESOURCE METRICS"
    docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.NetIO}}"
}

# ====================================================================
# MAINTENANCE COMMANDS
# ====================================================================

clean() {
    print_header "CLEANING UP"
    print_warning "This will remove all containers, images, and volumes"

    read -p "Type YES to continue: " -r
    if [[ ! $REPLY == "YES" ]]; then
        print_info "Cancelled"
        exit 0
    fi

    docker compose down -v --remove-orphans
    docker rmi $(docker images -q 'vedaai*') 2>/dev/null || true
    docker builder prune -a -f
    docker system prune -a -f --volumes

    print_header "CLEANUP COMPLETED"
}

prune() {
    print_status "Pruning unused Docker resources..."
    docker system prune -f
    print_status "Done"
}

# ====================================================================
# UTILITY
# ====================================================================

show_urls() {
    echo ""
    print_header "SERVICE URLS"
    echo "  Frontend:  http://localhost:3000"
    echo "  API:       http://localhost:8000"
    echo "  API Docs:  http://localhost:8000/docs"
    echo "  Redis:     localhost:6379"
    echo ""
}

# ====================================================================
# MAIN
# ====================================================================

case "$1" in
    init)     init ;;
    build)    build ;;
    rebuild)  rebuild ;;
    reload)   reload ;;
    start)    start ;;
    stop)     stop ;;
    restart)  restart ;;
    logs)     logs "$@" ;;
    status)   status ;;
    health)   health ;;
    metrics)  metrics ;;
    clean)    clean ;;
    prune)    prune ;;
    *)
        echo ""
        echo "============================================================"
        echo "                  VEDAAI - OPERATIONS CLI"
        echo "============================================================"
        echo ""
        echo "BUILD & DEPLOYMENT"
        echo "  init      - Build images + start stack (first-time / dep changes)"
        echo "  build     - Build images only (no startup)"
        echo "  rebuild   - Incremental rebuild (code changes only)"
        echo "  reload    - Restart with latest containers (no full rebuild)"
        echo ""
        echo "SERVICE LIFECYCLE"
        echo "  start     - Start all services"
        echo "  stop      - Stop all services"
        echo "  restart   - Restart all services"
        echo ""
        echo "OBSERVABILITY"
        echo "  logs [svc]  - Stream logs (api | worker | frontend | redis)"
        echo "  status      - Container status + resource usage"
        echo "  health      - Health checks for api, frontend, redis"
        echo "  metrics     - CPU / memory summary"
        echo ""
        echo "MAINTENANCE"
        echo "  clean     - Remove containers, images, volumes (destructive)"
        echo "  prune     - Remove unused Docker resources"
        echo ""
        echo "URLS (when running)"
        echo "  Frontend:  http://localhost:3000"
        echo "  API:       http://localhost:8000"
        echo "  API Docs:  http://localhost:8000/docs"
        echo ""
        exit 1
        ;;
esac
