.PHONY: build app release-archive install run test clean md-select-eval app-e2e search-e2e md-production-eval

PREFIX ?= /Applications
APP_NAME = Roc Mind Spark.app

build:
	cd macos && swift build -c release

app: build
	bash scripts/package-app.sh

release-archive: app
	bash scripts/package-release.sh

install: app
	bash scripts/install-app.sh "$(PREFIX)"

run: install
	open "$(PREFIX)/$(APP_NAME)"

test:
	cd web && node --test "test/*.test.mjs"
	cd macos && swift test

md-select-eval:
	swift scripts/md-select-eval.swift "$(CURDIR)/scripts/md-select-eval.html"
	swift scripts/md-select-eval.swift --overlay "$(CURDIR)/scripts/md-select-eval.html"

# These use WKWebView and an isolated SQLite database that the runner deletes.
app-e2e:
	node scripts/app-e2e.mjs

search-e2e:
	node scripts/search-e2e.mjs

md-production-eval:
	node scripts/md-production-eval.mjs --overlay

clean:
	rm -rf macos/.build dist
