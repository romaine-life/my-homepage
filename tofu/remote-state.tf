locals {
  infra = {
    resource_group_name          = "infra"
    dns_zone_name                = "romaine.life"
    cosmos_db_account_name       = "infra-cosmos-serverless"
    cosmos_db_account_id         = "/subscriptions/aee0cbd2-8074-4001-b610-0f8edb4eaa3c/resourceGroups/infra/providers/Microsoft.DocumentDB/databaseAccounts/infra-cosmos-serverless"
    azure_app_config_endpoint    = "https://infra-appconfig.azconfig.io"
    azure_app_config_resource_id = "/subscriptions/aee0cbd2-8074-4001-b610-0f8edb4eaa3c/resourceGroups/infra/providers/Microsoft.AppConfiguration/configurationStores/infra-appconfig"
  }
}
