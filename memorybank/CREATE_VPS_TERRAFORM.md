# 1. Set your DigitalOcean token
export TF_VAR_do_token="your-token-here"

# 2. Initialize (first time only)
tofu init

# 3. Validate config
tofu validate

# 4. See what will be created
tofu plan

# 5. Create all 3 VPS servers at once (NOT one by one!)
tofu apply

# 6. Get all IP addresses
tofu output vps_servers
tofu output vps_ips_list





#######
# 1 VPS in Singapore
tofu apply

# 3 VPS: Singapore, NY, London
tofu apply -var="vps_count=3"

# 5 VPS: Singapore, NY, London, Singapore, NY
tofu apply -var="vps_count=5"