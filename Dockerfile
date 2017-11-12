FROM node:8.9.0

WORKDIR /probot-app-todos

COPY package.json yarn.lock /probot-app-todos/

RUN yarn
