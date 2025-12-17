# MongoDB Setup

Configure MongoDB as the database for Jrok.

## Options

1. **MongoDB Atlas** (Recommended) - Free cloud-hosted MongoDB
2. **Self-Hosted MongoDB** - Run on your own server

## MongoDB Atlas (Recommended)

### Step 1: Create an Account

1. Go to [MongoDB Atlas](https://cloud.mongodb.com)
2. Sign up for a free account
3. Verify your email

### Step 2: Create a Cluster

1. Click **"Build a Database"**
2. Select **"FREE" (M0 Sandbox)** - Free forever, 512MB storage
3. Choose your cloud provider and region:
   - **AWS** → Pick region closest to your VPS
   - **Google Cloud** or **Azure** work too
4. Name your cluster (e.g., `jrok-cluster`)
5. Click **"Create Cluster"**

### Step 3: Create Database User

1. Go to **"Database Access"** (left sidebar)
2. Click **"Add New Database User"**
3. Choose **"Password"** authentication
4. Enter username and password:
   - Username: `jrokuser`
   - Password: Generate a secure password
5. Set **"Built-in Role"** to **"Read and write to any database"**
6. Click **"Add User"**

> 💡 Save the password securely - you'll need it for the connection string.

### Step 4: Configure Network Access

1. Go to **"Network Access"** (left sidebar)
2. Click **"Add IP Address"**
3. Choose one:
   - **"Allow Access from Anywhere"** (`0.0.0.0/0`) - Easiest for dynamic IPs
   - Or add your specific VPS IP addresses
4. Click **"Confirm"**

> ⚠️ For production, consider using VPC peering or private endpoints.

### Step 5: Get Connection String

1. Go to **"Database"** (left sidebar)
2. Click **"Connect"** on your cluster
3. Choose **"Connect your application"**
4. Select **"Driver: Node.js"** and latest version
5. Copy the connection string

It looks like:
```
mongodb+srv://jrokuser:<password>@jrok-cluster.xxxxx.mongodb.net/?retryWrites=true&w=majority
```

### Step 6: Configure Connection String

Replace `<password>` and add database name:

```bash
MONGODB_URI=mongodb+srv://jrokuser:YOUR_PASSWORD@jrok-cluster.xxxxx.mongodb.net/jrok?retryWrites=true&w=majority
```

## Self-Hosted MongoDB

### Using Docker

```yaml
# docker-compose.yml
services:
  mongodb:
    image: mongo:7
    container_name: jrok-mongodb
    restart: always
    ports:
      - "27017:27017"
    volumes:
      - mongodb_data:/data/db
    environment:
      - MONGO_INITDB_ROOT_USERNAME=admin
      - MONGO_INITDB_ROOT_PASSWORD=your-secure-password

volumes:
  mongodb_data:
```

Connection string:
```bash
MONGODB_URI=mongodb://admin:your-secure-password@localhost:27017/jrok?authSource=admin
```

### Native Installation (Ubuntu)

```bash
# Import MongoDB public key
curl -fsSL https://www.mongodb.org/static/pgp/server-7.0.asc | \
   sudo gpg -o /usr/share/keyrings/mongodb-server-7.0.gpg --dearmor

# Add repository
echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-7.0.gpg ] https://repo.mongodb.org/apt/ubuntu jammy/mongodb-org/7.0 multiverse" | \
   sudo tee /etc/apt/sources.list.d/mongodb-org-7.0.list

# Install
sudo apt-get update
sudo apt-get install -y mongodb-org

# Start
sudo systemctl start mongod
sudo systemctl enable mongod
```

## Database Schema

Jrok automatically creates these collections:

| Collection | Description |
|------------|-------------|
| `users` | User accounts from OAuth |
| `organizations` | Organizations (multi-tenant) |
| `apikeys` | API keys for CLI authentication |
| `sessions` | User sessions |
| `tunnels` | Active and historical tunnels |
| `domains` | Custom domains with certificates |
| `vpsservers` | Registered VPS servers |
| `certificates` | SSL certificate storage |
| `bandwidthStats` | Usage statistics |
| `activities` | Audit log |

## Connection String Format

### Atlas (SRV)

```
mongodb+srv://username:password@cluster.mongodb.net/database?options
```

### Standard

```
mongodb://username:password@host:port/database?options
```

### With Replica Set

```
mongodb://user:pass@host1:27017,host2:27017,host3:27017/database?replicaSet=rs0
```

## Configuration Options

| Option | Description | Default |
|--------|-------------|---------|
| `retryWrites` | Retry writes on failure | `true` |
| `w` | Write concern | `majority` |
| `maxPoolSize` | Max connections | `100` |
| `connectTimeoutMS` | Connection timeout | `10000` |

Example with all options:
```
mongodb+srv://user:pass@cluster.mongodb.net/jrok?retryWrites=true&w=majority&maxPoolSize=50&connectTimeoutMS=10000
```

## Testing Connection

### Using mongosh

```bash
# Install mongosh
npm install -g mongosh

# Test connection
mongosh "mongodb+srv://user:pass@cluster.mongodb.net/jrok"

# List collections
show collections
```

### Using Node.js

```javascript
const { MongoClient } = require('mongodb');

const uri = "mongodb+srv://user:pass@cluster.mongodb.net/jrok";
const client = new MongoClient(uri);

async function test() {
  try {
    await client.connect();
    console.log("Connected successfully!");
    const db = client.db("jrok");
    const collections = await db.listCollections().toArray();
    console.log("Collections:", collections.map(c => c.name));
  } finally {
    await client.close();
  }
}

test();
```

## Backup and Restore

### Atlas Backup (Automatic)

M0 clusters have limited backup. Upgrade to M2+ for automatic backups.

### Manual Backup

```bash
# Using mongodump
mongodump --uri="mongodb+srv://user:pass@cluster.mongodb.net/jrok" --out=./backup

# Restore
mongorestore --uri="mongodb+srv://user:pass@cluster.mongodb.net/jrok" ./backup/jrok
```

## Monitoring

### Atlas Monitoring

1. Go to your cluster in Atlas
2. Click **"Metrics"** tab
3. View:
   - Connections
   - Operations
   - Storage
   - Performance

### Self-Hosted

Use MongoDB Compass or `mongostat`:

```bash
mongostat --uri="mongodb://localhost:27017"
```

## Troubleshooting

### Connection Timeout

```bash
# Check if MongoDB is running
sudo systemctl status mongod

# Check connectivity
nc -zv cluster.mongodb.net 27017
```

### Authentication Failed

- Verify username/password
- Check user has correct permissions
- Ensure database name in URI matches

### IP Not Whitelisted (Atlas)

```
MongoServerError: bad auth Authentication failed
```

Add your server's IP to Network Access in Atlas.

### Too Many Connections

Default pool size is 100. For high-traffic:

```bash
MONGODB_URI=mongodb+srv://...?maxPoolSize=200
```

---

## Security Best Practices

1. **Use strong passwords** - Generate with `openssl rand -base64 32`
2. **Restrict IP access** - Whitelist only necessary IPs
3. **Enable authentication** - Never run without auth in production
4. **Use TLS/SSL** - Atlas uses it by default
5. **Regular backups** - Automate backups for disaster recovery
6. **Rotate credentials** - Change passwords periodically

---

## Next Steps

- [Environment Variables](./environment.md) - All configuration options
- [Self-Hosting Guide](../deployment/self-hosting.md) - Complete deployment
