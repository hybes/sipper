FROM ubuntu:24.04@sha256:008173c23f95b170204355c12626cb5a965d779a7e1283b09e9cffbb1bf33ca3 AS build
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential pkg-config curl ca-certificates bzip2 patch python3 \
    libedit-dev libjansson-dev libsqlite3-dev libxml2-dev uuid-dev libssl-dev \
    libpq-dev zlib1g-dev libsrtp2-dev libcurl4-openssl-dev libopus-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN curl -fsSLo asterisk.tar.gz https://downloads.asterisk.org/pub/telephony/asterisk/asterisk-22.11.0.tar.gz \
    && echo '3bd5ee040509a3d3cd9b1ba9520c18e6ec0a7e7981ca68c457dcd36ba3c54d94  asterisk.tar.gz' | sha256sum -c - \
    && tar -xzf asterisk.tar.gz --strip-components=1 && rm asterisk.tar.gz
# Upstream's PostgreSQL debug output includes the database password. Remove that
# statement even though debug logging is disabled by our runtime configuration.
RUN sed -i '/PostgreSQL RealTime Password:/d' res/res_config_pgsql.c \
    && ./configure --with-pjproject-bundled --with-postgres --without-dahdi --without-pri \
    && make menuselect.makeopts \
    && menuselect/menuselect --disable BUILD_NATIVE --disable-category MENUSELECT_CORE_SOUNDS \
       --disable-category MENUSELECT_MOH --disable-category MENUSELECT_EXTRA_SOUNDS menuselect.makeopts \
    && make -j4 && make install DESTDIR=/out \
    && test -f /out/usr/lib/asterisk/modules/res_config_pgsql.so \
    && mkdir -p /out/usr/share/doc/sipper-asterisk && cp COPYING LICENSE /out/usr/share/doc/sipper-asterisk/

# An ICE restart must replace stale credentials even while checks are in progress.
COPY patches/ice-credential-restart.patch /tmp/ice-credential-restart.patch
# Sorcery otherwise sends ARI changes to every mapped writable backend, including
# our read-only device views. Rejected SQL can log upstream password fields.
# This image uses realtime only for reads; contacts retain their default AstDB
# backend and upstream objects use memory. Remove the three write callbacks.
RUN patch -p1 < /tmp/ice-credential-restart.patch \
    && sed -i '/^[[:space:]]*\.create = sorcery_realtime_create,/d; /^[[:space:]]*\.update = sorcery_realtime_update,/d; /^[[:space:]]*\.delete = sorcery_realtime_delete,/d' res/res_sorcery_realtime.c \
    && make -j4 && make install DESTDIR=/out

# Asterisk's format module alone only passes Opus through. Build the GPL codec
# for Opus-to-G.711/G.722 calls, retaining Asterisk's own SDP format module.
RUN curl -fsSLo /tmp/opus-codec.tar.gz https://codeload.github.com/wazo-platform/wazo-codec-opus-open-source/tar.gz/591b6cd9b75e2b9b6d815ef364a385fccee595a7 \
    && echo '4b9b6b7e05d1450bf88932fdac280d210f6209c4fefed8b7c82995fbc869ed70  /tmp/opus-codec.tar.gz' | sha256sum -c - \
    && mkdir /opus-codec && tar -xzf /tmp/opus-codec.tar.gz -C /opus-codec --strip-components=1 \
    && make -C /opus-codec codec_opus_open_source CPATH='-I/opus-codec/include -I/src/include' LIBS='-Wl,--no-as-needed -lopus -Wl,--as-needed' \
    && readelf -d /opus-codec/codecs/codec_opus_open_source.so | grep -F 'libopus.so.0' \
    && install -m 755 /opus-codec/codecs/codec_opus_open_source.so /out/usr/lib/asterisk/modules/ \
    && mkdir -p /out/usr/share/doc/sipper-asterisk/opus-codec \
    && cp /opus-codec/LICENSE /opus-codec/README.md /out/usr/share/doc/sipper-asterisk/opus-codec/ \
    && rm /tmp/opus-codec.tar.gz

FROM ubuntu:24.04@sha256:008173c23f95b170204355c12626cb5a965d779a7e1283b09e9cffbb1bf33ca3
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates python3 libedit2 libjansson4 libsqlite3-0 libxml2 libuuid1 \
    libssl3t64 libpq5 libsrtp2-1 libcurl4t64 libopus0 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 asterisk && useradd --uid 10001 --gid asterisk --no-create-home asterisk
COPY --from=build /out/usr/ /usr/
COPY --from=build /out/var/lib/asterisk/ /var/lib/asterisk/
COPY config/ /etc/asterisk/
COPY config/ /usr/share/sipper-asterisk/config/
COPY entrypoint.py /usr/local/bin/sipper-asterisk
COPY media_config.py /usr/local/bin/media_config.py
RUN mkdir -p /run/asterisk /var/log/asterisk /var/spool/asterisk /var/lib/asterisk \
    && chown -R asterisk:asterisk /etc/asterisk /run/asterisk /var/log/asterisk /var/spool/asterisk /var/lib/asterisk
USER asterisk
ENTRYPOINT ["python3", "/usr/local/bin/sipper-asterisk"]
