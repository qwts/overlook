---
'photos': patch
---

Fix the performance collapse that froze the app for days after a 113K-file import. The backup sweep re-materialized the entire dirty set (~94K rows) after every item to publish the pending count (O(N²)) and re-queried ledger status twice per item before the first upload; the pending count is now tracked incrementally and the dirty query carries the status. SQL helpers cache prepared statements per connection (statement re-preparation was ~25% of profiled CPU), the SQLCipher page cache is sized to 64MB so B-tree seeks stop re-decrypting pages, and ten consecutive transient upload failures now abort the run (dirty rows resume next run) instead of burning retries on every remaining item while the network is down.
