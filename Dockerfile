# Use the official Node.js 18 image as the base image
FROM node:18

# Set the working directory inside the container
WORKDIR /app

# Copy the package.json and package-lock.json files to the working directory
COPY package*.json ./

# Install the application dependencies
RUN npm install

# Install TypeScript and ts-node globally
RUN npm install -g typescript ts-node

# Copy the rest of the application code to the working directory
COPY . .

# Expose port 8080 to the outside world
EXPOSE 8080

# Define the command to run your application
CMD ["npm", "start"]