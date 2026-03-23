resource "azurerm_static_web_app" "homepage" {
  name                = "homepage-app"
  resource_group_name = azurerm_resource_group.homepage.name
  location            = azurerm_resource_group.homepage.location
  sku_tier            = "Free"
  sku_size            = "Free"
  lifecycle {
    ignore_changes = [
      repository_url,
      repository_branch
    ]
  }
}

locals {
  front_app_dns_name = "homepage"
}

resource "azurerm_dns_cname_record" "homepage" {
  name                = local.front_app_dns_name
  zone_name           = local.infra.dns_zone_name
  resource_group_name = local.infra.resource_group_name
  ttl                 = 3600
  record              = azurerm_static_web_app.homepage.default_host_name
}

resource "azurerm_static_web_app_custom_domain" "homepage" {
  static_web_app_id = azurerm_static_web_app.homepage.id
  domain_name       = "${local.front_app_dns_name}.${local.infra.dns_zone_name}"
  validation_type   = "cname-delegation"
  depends_on        = [azurerm_dns_cname_record.homepage]
}

# ============================================================================
# Auth0 — Apple Sign-In only (server-side via Regular Web App)
# ============================================================================
# GitHub, Google, and Microsoft are handled by passport.js directly.
# Auth0 is retained solely for Apple Sign-In (avoids $99/year Apple Developer fee).

resource "auth0_client" "backend_apple" {
  name           = "homepage-backend-apple"
  app_type       = "regular_web"
  is_first_party = true
  callbacks = [
    # Shared API
    "https://api.${local.infra.dns_zone_name}/homepage/auth/apple/callback",
    # Local development
    "http://localhost:3000/homepage/auth/apple/callback",
  ]
  grant_types = ["authorization_code"]
}

resource "auth0_client_credentials" "backend_apple" {
  client_id             = auth0_client.backend_apple.id
  authentication_method = "client_secret_post"
}

resource "auth0_connection_clients" "apple_backend" {
  connection_id   = local.infra.auth0_connection_apple_id
  enabled_clients = [auth0_client.backend_apple.id]
}

