FROM postgres:17-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73
RUN apk add --no-cache age bash
COPY database-backup.sh database-restore.sh database-release.sh /usr/local/bin/
COPY recovery-reset.sql /usr/local/share/sipper/recovery-reset.sql
RUN chmod 755 /usr/local/bin/database-*.sh
USER postgres
ENTRYPOINT []
CMD ["database-backup.sh"]
