#!/bin/bash

if [ -z "$1" ]; then
    echo "Error: Docker host not provided."
    echo "Usage: $0 <docker_host>"
    exit 1
fi

DOCKER_HOST=$1

# check if docker containerd-snapshotter is enabled in deamon.json
if [ ! -f /etc/docker/daemon.json ]; then
    # create daemon.json if it doesn't exist
    # add features:containerd-snapshotter = true
    echo "Creating /etc/docker/daemon.json"
    sudo mkdir -p /etc/docker
    sudo touch /etc/docker/daemon.json
    echo '{
        "features": {
            "containerd-snapshotter": true
        }
    }' | sudo tee /etc/docker/daemon.json >/dev/null
    # change access to rw for root and read for others
    sudo chmod 644 /etc/docker/daemon.json
    # change owner to root
    sudo chown root:root /etc/docker/daemon.json
    echo "Docker daemon configuration file created."
else
    # check if containerd-snapshotter is enabled
    if grep -q '"containerd-snapshotter": true' /etc/docker/daemon.json; then
        echo "Containerd snapshotter is already enabled."
    else
        # add containerd-snapshotter to daemon.json
        echo "Enabling containerd snapshotter in /etc/docker/daemon.json"
        sudo jq '.features.containerd-snapshotter = true' /etc/docker/daemon.json | sudo tee /etc/docker/daemon.json >/dev/null
        echo "Containerd snapshotter enabled."
        # check if docker daemon is running
        if ! systemctl is-active --quiet docker; then
            echo "Docker daemon is not running. Starting Docker daemon..."
            sudo systemctl start docker
            if [ $? -ne 0 ]; then
                echo "Error: Failed to start Docker daemon."
                exit 1
            fi
        else
            echo "Docker daemon is running."
            # restart docker daemon to apply changes
            echo "Restarting Docker daemon to apply changes..."
            sudo systemctl restart docker
            if [ $? -ne 0 ]; then
                echo "Error: Failed to restart Docker daemon."
                exit 1
            fi
        fi
    fi
fi

docker buildx build --platform linux/amd64,linux/arm64 . -t lector --progress=plain && docker tag lector:latest $DOCKER_HOST/lector && docker push $DOCKER_HOST/lector:latest
