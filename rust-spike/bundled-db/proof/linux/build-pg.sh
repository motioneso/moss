#!/usr/bin/env bash
# Builds Postgres 17.11, pgvector 0.8.7 and the moss_nodump add-on into
# $MOSS_SPIKE_SCRATCH/pg/17.11-linux-x86_64. Each binary finds its libraries relative to
# itself, so the bundle runs from any folder.
#
# Save the sources in $MOSS_SPIKE_SCRATCH/downloads first:
#   https://ftp.postgresql.org/pub/source/v17.11/postgresql-17.11.tar.bz2
#   https://github.com/pgvector/pgvector/archive/refs/tags/v0.8.7.tar.gz as pgvector-0.8.7.tar.gz
#
# Needs bison, flex and m4. The proof run used Ubuntu 24.04's packages, fetched with
# `apt-get download bison flex m4 libbison-dev` and unpacked with `dpkg-deb -x` into
# $MOSS_SPIKE_SCRATCH/tools/root, so nothing was installed system-wide.
set -euo pipefail
S=${MOSS_SPIKE_SCRATCH:?set MOSS_SPIKE_SCRATCH to a scratch folder}
HERE=$(cd "$(dirname "$0")" && pwd)
T=$S/tools/root
if [ -d "$T" ]; then
  export PATH=$T/usr/bin:$PATH M4=$T/usr/bin/m4 BISON_PKGDATADIR=$T/usr/share/bison
fi
PREFIX=$S/pg/17.11-linux-x86_64

cd $S/downloads
sha256sum -c - <<'SUMS'
dd27f2b3c59e73ed14aa3324901242bf69a032a6347805f274e6260322d42979  postgresql-17.11.tar.bz2
cac0b10c360f05b2d521200105ba3697e773d4cd3731f5a915a7e37ebe0bea85  pgvector-0.8.7.tar.gz
SUMS

mkdir -p $S/build && cd $S/build
rm -rf postgresql-17.11 pgvector-0.8.7 moss_nodump
tar xjf $S/downloads/postgresql-17.11.tar.bz2
tar xzf $S/downloads/pgvector-0.8.7.tar.gz
cd postgresql-17.11
./configure --prefix=$PREFIX --without-readline --with-icu --with-zstd --without-openssl \
  > $S/build/configure.log 2>&1
make -j"$(nproc)" rpathdir='$$ORIGIN/../lib' > $S/build/make.log 2>&1
make rpathdir='$$ORIGIN/../lib' install > $S/build/install.log 2>&1

cd $S/build/pgvector-0.8.7
make PG_CONFIG=$PREFIX/bin/pg_config OPTFLAGS="" > $S/build/pgvector.log 2>&1
make PG_CONFIG=$PREFIX/bin/pg_config install >> $S/build/pgvector.log 2>&1

cp -r "$HERE/../../pg-module" $S/build/moss_nodump
make -C $S/build/moss_nodump PG_CONFIG=$PREFIX/bin/pg_config install > $S/build/moss_nodump.log 2>&1
echo BUILD-OK
