.PHONY: test test-js test-rust serve

test: test-js test-rust

test-js:
	node tests/run_all.js

test-rust:
	cargo test --quiet

serve:
	python3 -m http.server 8080
