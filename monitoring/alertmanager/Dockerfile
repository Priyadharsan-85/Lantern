FROM prom/alertmanager:v0.27.0 AS alertmanager

FROM alpine:3.21

RUN apk add --no-cache ca-certificates gettext-envsubst \
    && mkdir -p /alertmanager \
    && chown nobody:nobody /alertmanager

COPY --from=alertmanager /bin/alertmanager /bin/alertmanager
COPY --from=alertmanager /bin/amtool /bin/amtool
COPY monitoring/alertmanager/entrypoint.sh /usr/local/bin/alertmanager-entrypoint

USER nobody
WORKDIR /alertmanager
ENTRYPOINT ["/bin/sh", "/usr/local/bin/alertmanager-entrypoint"]
