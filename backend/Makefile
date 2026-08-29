.PHONY: install test eval lint format indexes run worker seed

install:
	pip install -r requirements-dev.txt

test:
	pytest tests/unit tests/integration

eval:
	pytest tests/eval -s

lint:
	ruff check app tests
	mypy app

format:
	ruff format app tests

indexes:
	python -c "from app.db.session import create_all; create_all()"

run:
	uvicorn app.main:app --reload --port 8000

worker:
	celery -A app.workers.celery_app.celery_app worker --loglevel=INFO

seed:
	python -m app.scripts.seed_demo

debug-boxes:
	python -m app.scripts.draw_regions $(DOC)
