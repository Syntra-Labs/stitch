.PHONY: test serve

test:
	node tests/test_survival.js

serve:
	python3 -m http.server 8080
