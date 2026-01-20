# Use an official Node.js runtime as the base image
FROM node:20-alpine

# Set the working directory in the container
WORKDIR /app

# Set them as Environment Variables for the build process
ENV VITE_ALLOWED_HOSTS=jrok.koompi.cloud
ENV VITE_API_URL=https://tunnel.koompi.cloud

# Copy the package.json and package-lock.json files to the container
COPY package.json package-lock.json ./

# Install project dependencies
# Use npm ci for reproducible builds, then reinstall rollup to get correct platform binaries
RUN npm ci --omit=optional && npm install rollup @rollup/rollup-linux-x64-musl --save-optional

# Copy the rest of the project files to the container
COPY . .

# Build the React app
RUN npm run build

# Expose the port that the server will listen on
EXPOSE 4173

# Start the application
CMD [ "npm", "run", "preview", "--", "--host" ]