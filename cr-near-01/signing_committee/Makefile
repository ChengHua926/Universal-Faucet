CARGO ?= $(shell if command -v cargo >/dev/null 2>&1; then command -v cargo; else echo $$HOME/.cargo/bin/cargo; fi)
FORGE ?= $(shell if command -v forge >/dev/null 2>&1; then command -v forge; else echo $$HOME/.foundry/bin/forge; fi)

build:
	$(CARGO) build

test:
	$(CARGO) test
	$(FORGE) build

e2e:
	scripts/e2e_foundry_committee.sh
