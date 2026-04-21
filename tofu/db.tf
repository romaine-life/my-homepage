# Cosmos DB NoSQL Database (app-specific; account is managed by shared infra)
resource "azurerm_cosmosdb_sql_database" "homepage" {
  name                = "HomepageDB"
  resource_group_name = local.infra.resource_group_name
  account_name        = local.infra.cosmos_db_account_name
}

# Serverless account has no throughput to ignore. DB + container live on
# the new account; imports adopt them after a prior `tofu state rm` drops
# the old-account state entries.
import {
  to = azurerm_cosmosdb_sql_database.homepage
  id = "/subscriptions/aee0cbd2-8074-4001-b610-0f8edb4eaa3c/resourceGroups/infra/providers/Microsoft.DocumentDB/databaseAccounts/infra-cosmos-serverless/sqlDatabases/HomepageDB"
}

import {
  to = azurerm_cosmosdb_sql_container.userdata
  id = "/subscriptions/aee0cbd2-8074-4001-b610-0f8edb4eaa3c/resourceGroups/infra/providers/Microsoft.DocumentDB/databaseAccounts/infra-cosmos-serverless/sqlDatabases/HomepageDB/containers/userdata"
}

resource "azurerm_cosmosdb_sql_container" "userdata" {
  name                = "userdata"
  resource_group_name = local.infra.resource_group_name
  account_name        = local.infra.cosmos_db_account_name
  database_name       = azurerm_cosmosdb_sql_database.homepage.name
  partition_key_paths = ["/userId"]

  indexing_policy {
    indexing_mode = "consistent"

    included_path {
      path = "/*"
    }
  }
}
