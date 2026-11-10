.PHONY: test test-js test-rust serve

test: test-js test-rust

test-js:
	npm test
	python3 scripts/verify-custody.py

test-rust:
	cargo test --locked --quiet

serve:
	python3 -m http.server 8080
