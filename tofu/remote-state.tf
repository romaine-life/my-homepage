# ============================================================================
# Shared Infrastructure Variables (injected via Spacelift stack dependencies)
# ============================================================================
# These variables are automatically populated by Spacelift from the
# infra-bootstrap stack outputs via stack dependency references.

variable "infra_resource_group_name" {
  description = "Name of the shared resource group"
  type        = string
}

variable "infra_dns_zone_name" {
  description = "Name of the shared DNS zone"
  type        = string
}

variable "infra_container_app_environment_id" {
  description = "Resource ID of the shared Container App Environment"
  type        = string
}

variable "infra_cosmos_db_account_name" {
  description = "Name of the shared Cosmos DB account"
  type        = string
}

variable "infra_cosmos_db_account_id" {
  description = "Resource ID of the shared Cosmos DB account"
  type        = string
}

variable "infra_azure_app_config_endpoint" {
  description = "Endpoint URL for the shared Azure App Configuration store"
  type        = string
}

variable "infra_azure_app_config_resource_id" {
  description = "Resource ID of the shared Azure App Configuration store"
  type        = string
}

variable "infra_auth0_domain" {
  description = "Auth0 custom domain"
  type        = string
}

variable "infra_auth0_connection_apple_id" {
  description = "Auth0 Apple connection ID"
  type        = string
}

locals {
  infra = {
    resource_group_name            = var.infra_resource_group_name
    dns_zone_name                  = var.infra_dns_zone_name
    container_app_environment_id   = var.infra_container_app_environment_id
    cosmos_db_account_name         = var.infra_cosmos_db_account_name
    cosmos_db_account_id           = var.infra_cosmos_db_account_id
    azure_app_config_endpoint      = var.infra_azure_app_config_endpoint
    azure_app_config_resource_id   = var.infra_azure_app_config_resource_id
    auth0_domain                   = var.infra_auth0_domain
    auth0_connection_apple_id      = var.infra_auth0_connection_apple_id
  }
}
