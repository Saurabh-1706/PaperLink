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
# COMPOSE FILE SELECTION
# ====================================================================
# Overlays are opt-in flags rather than separate commands, so every existing
# command (build, logs, health, ...) works unchanged against whichever stack the
# flags select.
#
#   --gpu          CUDA worker + TrOCR handwriting recognition
#   --with-mongo   run MongoDB in a container (replica set) instead of on the host
#
# Flags may appear anywhere: `./vedaai.sh up --gpu` and `./vedaai.sh --gpu up` are
# the same thing.

COMPOSE_FILES="-f docker-compose.yml"
USE_GPU=0
USE_MONGO=0
ARGS=()

for arg in "$@"; do
    case "$arg" in
        --gpu)        USE_GPU=1 ;;
        --with-mongo) USE_MONGO=1 ;;
        --all)        USE_GPU=1; USE_MONGO=1 ;;
        *)            ARGS+=("$arg") ;;
    esac
done
set -- "${ARGS[@]:-}"

[ "$USE_MONGO" = "1" ] && COMPOSE_FILES="$COMPOSE_FILES -f docker-compose.mongo.yml"
[ "$USE_GPU" = "1" ]   && COMPOSE_FILES="$COMPOSE_FILES -f docker-compose.gpu.yml"

COMPOSE="docker compose $COMPOSE_FILES"

# A GPU stack that silently runs on CPU is the failure worth catching early: TrOCR
# decodes at ~7 s/line there instead of fractions of a second, so it looks like a
# hang rather than a misconfiguration.
preflight_gpu() {
    [ "$USE_GPU" = "1" ] || return 0
    print_header "GPU PREFLIGHT"
    if docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi > /dev/null 2>&1; then
        print_status "NVIDIA Container Toolkit is working; GPU visible to Docker"
    else
        print_error "Docker cannot see a GPU"
        print_info "Install the NVIDIA Container Toolkit, then verify with:"
        print_info "  docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi"
        print_info "Or drop --gpu to run the CPU stack (TrOCR stays off)."
        exit 1
    fi
}

describe_stack() {
    local gpu="CPU" mongo="host"
    [ "$USE_GPU" = "1" ]   && gpu="GPU (TrOCR handwriting recognition on)"
    [ "$USE_MONGO" = "1" ] && mongo="containerised (replica set, transactions on)"
    print_info "worker: $gpu"
    print_info "mongo:  $mongo"
}

# ====================================================================
# ONE-COMMAND STARTUP
# ====================================================================

up() {
    print_header "VEDAAI — FULL STACK"
    describe_stack

    if [ ! -f "backend/.env" ]; then
        print_warning "backend/.env not found — creating it from .env.example"
        cp backend/.env.example backend/.env
        print_info "Add your API keys to backend/.env when you need the LLM stages"
    fi

    preflight_gpu

    print_status "Building images..."
    $COMPOSE build --parallel
    print_status "Starting services..."
    $COMPOSE up -d

    if [ "$USE_MONGO" = "0" ]; then
        print_info "Using MongoDB on the host; pass --with-mongo to containerise it"
    fi

    show_urls
}

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
    $COMPOSE build --parallel

    print_status "Starting all services..."
    $COMPOSE up -d

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
    $COMPOSE build --no-cache --parallel
    end_time=$(date +%s)

    print_header "BUILD COMPLETED in $((end_time - start_time))s"
    print_info "Next: ./vedaai.sh start"
}

rebuild() {
    print_header "QUICK REBUILD - Code Changes Only"

    start_time=$(date +%s)

    $COMPOSE down --remove-orphans
    $COMPOSE build --parallel
    $COMPOSE up -d

    end_time=$(date +%s)
    print_header "REBUILD COMPLETED in $((end_time - start_time))s"
    show_urls
}

reload() {
    print_header "HOT RELOAD - Restart with Latest Containers"
    start_time=$(date +%s)
    $COMPOSE up -d --build
    end_time=$(date +%s)
    print_status "Reloaded in $((end_time - start_time))s"
    show_urls
}

# ====================================================================
# LIFECYCLE COMMANDS
# ====================================================================

start() {
    print_status "Starting all services..."
    $COMPOSE up -d
    print_status "Services started"
    show_urls
}

stop() {
    print_status "Stopping all services..."
    $COMPOSE down
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
        $COMPOSE logs -f
    else
        case "$service" in
            api|worker|frontend|redis)
                $COMPOSE logs -f "$service"
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
    $COMPOSE ps
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
    if $COMPOSE exec -T redis redis-cli ping > /dev/null 2>&1; then
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

    $COMPOSE down -v --remove-orphans
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

case "${1:-}" in
    up)       up ;;
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
        echo "  up        - Build + start EVERYTHING (use this)"
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
        echo "STACK FLAGS (combine with any command)"
        echo "  --gpu         CUDA worker + TrOCR handwriting recognition"
        echo "  --with-mongo  run MongoDB in a container instead of on the host"
        echo "  --all         both of the above"
        echo ""
        echo "  ./vedaai.sh up                 CPU stack, host mongo"
        echo "  ./vedaai.sh up --all           GPU stack, containerised mongo"
        echo "  ./vedaai.sh logs worker --gpu  logs from the GPU worker"
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
