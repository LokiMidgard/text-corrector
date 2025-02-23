
#!/bin/bash

if [ -z "$1" ]; then
    echo "Error: Docker host not provided."
    echo "Usage: $0 <docker_host>"
    exit 1
fi

DOCKER_HOST=$1

docker buildx build --platform linux/amd64,linux/arm64 . -t lector --progress=plain && docker tag lector:latest $DOCKER_HOST/lector && docker push $DOCKER_HOST/lector:latest
