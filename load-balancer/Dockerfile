FROM golang:1.27-alpine AS builder

WORKDIR /src

COPY go.mod main.go ./
RUN go build -o /out/voltgrid-load-balancer .

FROM alpine:3.22

COPY --from=builder /out/voltgrid-load-balancer /usr/local/bin/voltgrid-load-balancer

EXPOSE 8787

ENTRYPOINT ["/usr/local/bin/voltgrid-load-balancer"]
