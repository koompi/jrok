# main.tf
terraform {
  required_providers {
    # OpenTofu uses the existing Terraform providers
    digitalocean = {
      source = "digitalocean/digitalocean"
      version = "~> 2.0"
    }
  }
}

# The provider block configures the DigitalOcean provider.
# The DO_TOKEN environment variable will be used for authentication.

provider "digitalocean" {
  token = var.do_token
}

# Define the SSH key resource
resource "digitalocean_ssh_key" "my_key" {
  name       = "my-ssh-key"
  public_key = file(pathexpand("~/.ssh/id_rsa.pub"))  # Use pathexpand() to expand ~
}

# Define VPS servers (configurable count)
resource "digitalocean_droplet" "jrok" {
  count = var.vps_count
  
  image    = "ubuntu-22-04-x64"
  name     = "jrok-${count.index + 1}"                          # jrok-1, jrok-2, etc
  region   = var.regions[count.index % length(var.regions)]            # Cycle through regions
  size     = "s-1vcpu-1gb"
  ssh_keys = [digitalocean_ssh_key.my_key.id]
  
  tags     = ["jrok", "production"]
}

# Output all VPS IP addresses
output "vps_servers" {
  value = [
    for i, droplet in digitalocean_droplet.jrok :
    {
      name       = droplet.name
      ip_address = droplet.ipv4_address
      region     = droplet.region
      size       = droplet.size
    }
  ]
  description = "All VPS server details"
}

output "vps_ips_list" {
  value = [
    for droplet in digitalocean_droplet.jrok :
    droplet.ipv4_address
  ]
  description = "Simple list of all VPS IP addresses"
}

variable "do_token" {
  description = "DigitalOcean API Token"
  type        = string
  sensitive   = true
}

variable "vps_count" {
  description = "Number of VPS servers to create (1, 3, 5, etc)"
  type        = number
  default     = 1
}

variable "regions" {
  description = "List of regions for VPS servers (cycling through)"
  type        = list(string)
  default     = ["sgp1", "nyc1", "lon1"]
}