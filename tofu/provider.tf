terraform {
  backend "azurerm" {}
}

provider "azurerm" {
  features {}
  use_oidc = true
}
