FROM node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94

ADD --checksum=sha256:def59805cd14b5651b68990855f426ad087f3b96881296d963910431ba3143c8 \
    https://gitlab.vsplab.cn/api/v4/projects/107/packages/generic/vspi-ci-tools/1/fd-v10.4.2-x86_64-unknown-linux-gnu.tar.gz \
    /tmp/fd.tar.gz
ADD --checksum=sha256:1c9297be4a084eea7ecaedf93eb03d058d6faae29bbc57ecdaf5063921491599 \
    https://gitlab.vsplab.cn/api/v4/projects/107/packages/generic/vspi-ci-tools/1/ripgrep-15.1.0-x86_64-unknown-linux-musl.tar.gz \
    /tmp/rg.tar.gz

RUN apt-get update \
    && apt-get install -y --no-install-recommends bubblewrap=0.8.0-2+deb12u1 \
    && mkdir -p /tmp/fd /tmp/rg \
    && tar -xzf /tmp/fd.tar.gz -C /tmp/fd --strip-components=1 \
    && tar -xzf /tmp/rg.tar.gz -C /tmp/rg --strip-components=1 \
    && install -m 0755 /tmp/fd/fd /usr/local/bin/fd \
    && install -m 0755 /tmp/rg/rg /usr/local/bin/rg \
    && rm -rf /tmp/fd /tmp/rg /tmp/fd.tar.gz /tmp/rg.tar.gz \
    && bwrap --version \
    && fd --version \
    && rg --version

ARG VCS_REF=unknown
LABEL org.opencontainers.image.title="VSPi CI Node" \
      org.opencontainers.image.description="Versioned Node environment for VSPi verification and releases" \
      org.opencontainers.image.source="https://gitlab.vsplab.cn/heyx/vspi" \
      org.opencontainers.image.revision="$VCS_REF"

WORKDIR /builds
