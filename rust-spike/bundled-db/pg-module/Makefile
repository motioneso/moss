# Built against the bundled Postgres: make PG_CONFIG=<bundle>/bin/pg_config install
MODULES = moss_nodump
PG_CONFIG ?= pg_config
PGXS := $(shell $(PG_CONFIG) --pgxs)
include $(PGXS)
