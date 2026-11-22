UUID := growi@9ticks.github.io
ZIP := $(UUID).shell-extension.zip
SCHEMA_DIR := $(UUID)/schemas
EXTRA_SOURCES := $(filter-out $(UUID)/extension.js $(UUID)/prefs.js,$(wildcard $(UUID)/*.js)) $(UUID)/stylesheet.css

.PHONY: all schemas lint test pack install smoke clean

all: schemas lint test pack

schemas:
	glib-compile-schemas --strict $(SCHEMA_DIR)

lint:
	eslint $(UUID) tests tools/smoke-helper@local tools/prefs-check.js

test:
	gjs -m tests/run.js

pack: schemas
	gnome-extensions pack --force $(addprefix --extra-source=,$(notdir $(EXTRA_SOURCES))) $(UUID)

# Installs into the CURRENT user session; never used by automated checks.
install: pack
	gnome-extensions install --force $(ZIP)
	@echo "Installed $(UUID). On Wayland, log out and back in, then run: gnome-extensions enable $(UUID)"

smoke: pack
	tools/smoke.sh

clean:
	rm -f $(ZIP)
