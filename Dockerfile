# this is not working unless websocket is working for npm build

FROM --platform=$BUILDPLATFORM node:22-alpine AS build

# Create app directory

WORKDIR /usr/src/app

# Install app dependencies

COPY package*.json ./

# install dependencies
RUN npm install


# Bundle app source

COPY . .    

RUN npm run build


FROM node:22-alpine

WORKDIR /app

COPY --from=build /usr/src/app/build ./build
COPY --from=build /usr/src/app/wsServer.js .
COPY --from=build /usr/src/app/package*.json .
COPY --from=build /usr/src/app/node_modules ./node_modules

ENTRYPOINT [ "npm" ,"start"]