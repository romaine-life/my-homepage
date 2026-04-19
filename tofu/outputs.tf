output "resource_group_name" {
  value       = azurerm_resource_group.homepage.name
  description = "Name of the resource group"
}

output "cosmos_db_name" {
  value       = local.infra.cosmos_db_account_name
  description = "Cosmos DB account name"
}

output "cosmos_db_database_name" {
  value       = azurerm_cosmosdb_sql_database.homepage.name
  description = "Cosmos DB database name"
}

output "cosmos_db_container_name" {
  value       = azurerm_cosmosdb_sql_container.userdata.name
  description = "Cosmos DB container name for user data"
}

output "app_config_prefix" {
  value       = local.front_app_dns_name
  description = "App Configuration key prefix, derived from the frontend DNS name"
}

output "storage_account_name" {
  value       = azurerm_storage_account.profile_pictures.name
  description = "Name of the profile pictures storage account"
}

output "storage_account_endpoint" {
  value       = azurerm_storage_account.profile_pictures.primary_blob_endpoint
  description = "Primary blob endpoint for the profile pictures storage account"
}
