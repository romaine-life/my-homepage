# ============================================================================
# Azure Container Apps (Serverless Container Hosting)
# ============================================================================

locals {
  back_app_dns_name = "${local.front_app_dns_name}.api"
}

# Container App for the backend API
resource "azurerm_container_app" "homepage_api" {
  for_each = toset(["homepage-api"]) # Add more backend APIs here if needed
  name                         = each.key
  resource_group_name          = azurerm_resource_group.homepage.name
  container_app_environment_id = local.infra.container_app_environment_id
  revision_mode                = "Single"

  # Enable system-assigned managed identity
  identity {
    type = "SystemAssigned"
  }

  # Container configuration
  template {
    container {
      name   = each.key
      image  = "mcr.microsoft.com/azuredocs/containerapps-helloworld:latest"
      cpu    = 0.25
      memory = "0.5Gi"

      env {
        name  = "PORT"
        value = "3000"
      }

      env {
        name  = "AZURE_APP_CONFIG_ENDPOINT"
        value = local.infra.azure_app_config_endpoint
      }

      env {
        name  = "APP_CONFIG_PREFIX"
        value = local.front_app_dns_name
      }

      env {
        name  = "KEY_VAULT_URL"
        value = "https://${local.infra.key_vault_name}.vault.azure.net"
      }

      env {
        name  = "SWA_DEFAULT_HOSTNAME"
        value = azurerm_static_web_app.homepage.default_host_name
      }

    }

    min_replicas = 0 # Scale to zero when not in use
    max_replicas = 3
  }

  # Ingress configuration
  ingress {
    external_enabled = true
    target_port      = 3000

    traffic_weight {
      latest_revision = true
      percentage      = 100
    }

    cors {
      allowed_origins = [
        # Production: Default Azure hostname
        "https://${azurerm_static_web_app.homepage.default_host_name}",
        "https://${local.front_app_dns_name}.${local.infra.dns_zone_name}",

        # Development: Localhost
        "http://localhost:3000",
        "http://localhost:5500"
      ]

      allowed_methods           = ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"]
      allowed_headers           = ["*"]
      exposed_headers           = ["*"]
      max_age_in_seconds        = 3600
      allow_credentials_enabled = true
    }
  }
  lifecycle {
    ignore_changes = [
      template[0].container[0].image
    ]
  }
}

# Grant Container App managed identity access to Cosmos DB
resource "azurerm_cosmosdb_sql_role_assignment" "container_app_cosmos" {
  resource_group_name = local.infra.resource_group_name
  account_name        = local.infra.cosmos_db_account_name
  role_definition_id  = "${local.infra.cosmos_db_account_id}/sqlRoleDefinitions/00000000-0000-0000-0000-000000000002" # Built-in Data Contributor
  principal_id        = azurerm_container_app.homepage_api["homepage-api"].identity[0].principal_id
  scope               = local.infra.cosmos_db_account_id
}

# Grant Container App managed identity read access to Azure App Configuration
resource "azurerm_role_assignment" "container_app_appconfig_reader" {
  scope                = local.infra.azure_app_config_resource_id
  role_definition_name = "App Configuration Data Reader"
  principal_id         = azurerm_container_app.homepage_api["homepage-api"].identity[0].principal_id
}

# 1. The Verification Record (Proves to Azure you own the domain)
resource "azurerm_dns_txt_record" "homepage_api_verification" {
  name                = "asuid.${local.back_app_dns_name}"
  zone_name           = local.infra.dns_zone_name
  resource_group_name = local.infra.resource_group_name
  ttl                 = 3600

  record {
    value = azurerm_container_app.homepage_api["homepage-api"].custom_domain_verification_id
  }
}

# 2. The Routing Record (Points to the container ingress)
resource "azurerm_dns_cname_record" "homepage_api" {
  name                = local.back_app_dns_name
  zone_name           = local.infra.dns_zone_name
  resource_group_name = local.infra.resource_group_name
  ttl                 = 3600
  record              = azurerm_container_app.homepage_api["homepage-api"].ingress[0].fqdn
}

# 3a. Register the custom domain on the container app (no cert yet — Azure
#     requires the hostname to exist before a managed certificate can be issued).
resource "azurerm_container_app_custom_domain" "homepage_api" {
  name                     = "${local.back_app_dns_name}.${local.infra.dns_zone_name}"
  container_app_id         = azurerm_container_app.homepage_api["homepage-api"].id
  certificate_binding_type = "Disabled"

  # The cert binding is applied in step 3c via azapi — ignore drift here.
  lifecycle {
    ignore_changes = [certificate_binding_type, container_app_environment_certificate_id]
  }

  depends_on = [
    azurerm_dns_txt_record.homepage_api_verification,
    azurerm_dns_cname_record.homepage_api
  ]
}

# 3b. Azure Managed Certificate (via azapi — azurerm doesn't support this resource type)
resource "azapi_resource" "homepage_api_managed_cert" {
  type      = "Microsoft.App/ManagedEnvironments/managedCertificates@2024-03-01"
  name      = "homepage-api-cert"
  parent_id = local.infra.container_app_environment_id
  location  = var.location

  body = {
    properties = {
      subjectName             = "${local.back_app_dns_name}.${local.infra.dns_zone_name}"
      domainControlValidation = "CNAME"
    }
  }

  depends_on = [
    azurerm_container_app_custom_domain.homepage_api
  ]
}

# 3c. Bind the managed certificate to the custom domain (PATCH the container app)
resource "azapi_update_resource" "homepage_api_cert_binding" {
  type        = "Microsoft.App/containerApps@2024-03-01"
  resource_id = azurerm_container_app.homepage_api["homepage-api"].id

  body = {
    properties = {
      configuration = {
        ingress = {
          customDomains = [
            {
              name          = "${local.back_app_dns_name}.${local.infra.dns_zone_name}"
              certificateId = azapi_resource.homepage_api_managed_cert.id
              bindingType   = "SniEnabled"
            }
          ]
        }
      }
    }
  }

  depends_on = [
    azapi_resource.homepage_api_managed_cert
  ]
}

# Grant Container App managed identity read access to Key Vault secrets
resource "azurerm_role_assignment" "container_app_keyvault_reader" {
  scope                = data.azurerm_key_vault.main.id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_container_app.homepage_api["homepage-api"].identity[0].principal_id
}
