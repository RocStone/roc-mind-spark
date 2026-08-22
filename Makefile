.PHONY: build app install run test clean

PREFIX ?= /Applications
APP_NAME = Roc Mind Spark.app

build:
	cd macos && swift build -c release

app: build
	bash scripts/package-app.sh

install: app
	bash scripts/install-app.sh "$(PREFIX)"

run: install
	open "$(PREFIX)/$(APP_NAME)"

test:
	cd web && node --test "test/*.test.mjs"

clean:
	rm -rf macos/.build dist
