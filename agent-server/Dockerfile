ARG PYTHON_BASE_IMAGE=docker.m.daocloud.io/library/python:3.11.9-slim-bookworm
FROM ${PYTHON_BASE_IMAGE} AS runtime-base

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

ARG APT_MIRROR=https://mirrors.tuna.tsinghua.edu.cn
RUN set -eux; \
    if [ -n "$APT_MIRROR" ] && [ -f /etc/apt/sources.list.d/debian.sources ]; then \
        sed -i "s|https\?://deb.debian.org/debian|$APT_MIRROR/debian|g; s|https\?://security.debian.org/debian-security|$APT_MIRROR/debian-security|g" /etc/apt/sources.list.d/debian.sources; \
    fi; \
    apt-get update; \
    apt-get install -y --no-install-recommends libstdc++6; \
    rm -rf /var/lib/apt/lists/*

FROM runtime-base AS dependencies
ARG PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN python -m venv /opt/venv \
    && /opt/venv/bin/python -m pip install --no-cache-dir -i "$PIP_INDEX_URL" -r requirements.txt

FROM runtime-base AS runtime
ENV PATH="/opt/venv/bin:${PATH}"
COPY --from=dependencies /opt/venv /opt/venv

COPY requirements.txt .
COPY app ./app

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
