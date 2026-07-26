FROM node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94

ARG VCS_REF=unknown
LABEL org.opencontainers.image.title="VSPi CI Node" \
      org.opencontainers.image.description="Reproducible Node environment for VSPi verification and releases" \
      org.opencontainers.image.source="https://gitlab.vsplab.cn/heyx/vspi" \
      org.opencontainers.image.revision="$VCS_REF"

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates curl git tar \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /builds
