FROM docker.io/alpine:3.21.2

# Add some dependencies.
RUN apk add --no-cache curl jq busybox-extras

# The entire application is defined as a shell script.
ADD app.sh /app.sh
ENTRYPOINT ["/app.sh"]
