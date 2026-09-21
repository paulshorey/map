# Railway Infrastructure as Code

This file defines the Map Railway project. Before its first apply, authenticate
and link the repository, then import the live project with `railway config pull
--force`. Keep every imported resource (such as databases, volumes, buckets,
and custom domains) in this specification when reconciling the imported file
with the service settings here. A whole-project IaC file treats an omitted
resource as a deletion. Run `railway config plan` from the repository root and
apply only after the plan contains no unexpected destructive changes.
