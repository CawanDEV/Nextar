FROM golang:1.23-alpine AS build
WORKDIR /src
COPY go.mod ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /api ./cmd/api
FROM alpine:3.21
WORKDIR /app
COPY --from=build /api /app/api
COPY migrations /app/migrations
EXPOSE 8080
CMD ["/app/api"]
