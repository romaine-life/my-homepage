resource "azurerm_resource_group" "homepage" {
  name     = "homepage-rg"
  location = var.location
}

# App identity used for App Configuration key prefix. Now that the app is
# frontend-only on AKS, the local just gates the keyed-config structure —
# the hostname itself (homepage.romaine.life) is set in k8s manifests.
locals {
  front_app_dns_name = "homepage"
}
