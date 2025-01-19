FROM node:22-alpine as build

# Create app directory

WORKDIR /usr/src/app

# create build directory

RUN mkdir build


# Install app dependencies
# A wildcard is used to ensure both package.json AND package-lock.json are copied

COPY package*.json ./

# copy package.json to build directory

COPY package*.json build/


# install dependencies
RUN npm install

#install dependencies in build directory

RUN cd build && npm ci --omit dev

# Bundle app source

COPY . .    

RUN npm run build


FROM node:22-alpine

WORKDIR /app

COPY --from=build /usr/src/app/build .

ENTRYPOINT [ "node" ,"."]