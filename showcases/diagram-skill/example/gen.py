import json
T="package:bank/transfers"; A="package:bank/accounts"; L="package:bank/ledger"; AU="package:bank/auth"; DB="database:Database"
n=[0]
def eid():
    n[0]+=1; return n[0]
def q(sql, caller=None, d=None):
    a={"nodeType":6,"callee":DB,"query":sql,"children":[],"eventIds":[eid()]}
    if caller: a["caller"]=caller
    if d: a["diffMode"]=d
    return a
def f(name, callee, children=(), caller=None, d=None, raises=False):
    a={"nodeType":3,"callee":callee,"name":name,"static":True,
       "stableProperties":{"event_type":"function","id":name,"raises_exception":raises},
       "returnValue":{"raisesException":raises},"eventIds":[eid()],"children":list(children)}
    if caller: a["caller"]=caller
    if d: a["diffMode"]=d
    return a
actors=lambda ids:[{"id":i,"name":nm,"order":o} for i,nm,o in ids]

# 1. The finding: a transfer out of an account the caller does not own.
seq={"actors":actors([(T,"transfers",1000),(A,"accounts",1000),(L,"ledger",1000),(DB,"Database",4000)]),
 "rootActions":[
  q("-- 2 times\nINSERT INTO customers (name, email) VALUES (%s, %s)"),
  q("-- 2 times\nINSERT INTO accounts (owner_id, balance) VALUES (%s, %s)"),
  q("INSERT INTO sessions (customer_id, token) VALUES (%s, %s)"),
  f("create_transfer",T,[
    f("current_customer",T,caller=T),
    f("find_account",A,[q("SELECT accounts.* FROM accounts WHERE accounts.id = %s",A)],caller=T),
    f("has_funds",A,caller=T),
    f("post_entries",L,[
      q("-- 2 times\nINSERT INTO ledger_entries (account_id, amount) VALUES (%s, %s)",L),
      q("-- 2 times\nUPDATE accounts SET balance = %s WHERE accounts.id = %s",L)],caller=T),
    q("INSERT INTO transfers (source_id, target_id, amount) VALUES (%s, %s, %s)",T),
    f("notify_customer",T,[q("INSERT INTO notifications (customer_id, body) VALUES (%s, %s)",T)],caller=T),
  ]),
  q("SELECT accounts.balance FROM accounts WHERE accounts.id = %s"),
 ]}
json.dump(seq,open("finding.sequence.json","w"),indent=1)
json.dump({"metadata":{"name":"transfer debits the source account"},"events":[]},open("finding.appmap.json","w"))
notes={
 "title":"Moving money out of someone else's account",
 "subtitle":"AppMap trace of test_transfer_debits_source_account at HEAD 4f2c9ae · behind the improper authorization finding (HIGH)",
 "pageTitle":"Transfer Authorization Trace",
 "lanes":[{"id":"app","name":"Customer B's app","sub":"not in the trace"}],
 "rootLane":"app","rootQueryLane":T,
 "laneLabels":{T:{"sub":"transfers.py"},A:{"sub":"accounts.py"},L:{"sub":"ledger.py"}},
 "hide":["current_customer"],"collapse":["notify_customer"],
 "setup":{"text":"test setup: customers A and B, one account each, B signed in"},
 "steps":[
  {"at":"create_transfer","heading":"2 · B submits the transfer"},
  {"at":"post_entries","heading":"3 · The money moves"},
  {"at":"sql:SELECT accounts.balance","heading":"4 · The test re-reads A's balance"}],
 "notes":[
  {"before":"create_transfer","heading":"1 · B's app builds the request","lane":"app","kind":"client",
   "lines":[{"text":"POST /transfers","mono":True},{"text":"source: A's account, $250","mono":True},{"text":"→ B can name any account","bold":True}]},
  {"after":"find_account","plain":True,"kind":"info","lane":L,"lines":["found · owner is Customer A"]},
  {"after":"has_funds","kind":"error","mono":True,"lane":A,
   "lines":["has_funds(source, 250)   transfers.py:48","# source.owner_id is never checked"]},
  {"after":"sql:SELECT accounts.balance","plain":True,"kind":"error","lines":["A's balance is down $250 · B never owned the account"]}],
 "footer":"Calls and SQL are from the trace. Dashed lanes and boxes are drawn from the source."}
json.dump(notes,open("finding.notes.json","w"),indent=1)

# 2. The changed gold trace, after the fix.
n[0]=0
diff={"actors":actors([(T,"transfers",1000),(A,"accounts",1000),(L,"ledger",1000),(DB,"Database",4000)]),
 "rootActions":[
  f("create_transfer",T,[
    f("find_account",A,[q("SELECT accounts.* FROM accounts WHERE accounts.id = %s",A)],caller=T),
    f("authorize_owner",A,[q("SELECT account_owners.* FROM account_owners WHERE account_id = %s",A,1)],caller=T,d=1),
    f("has_funds",A,caller=T),
    f("post_entries",L,[
      q("SELECT accounts.balance FROM accounts WHERE accounts.id = %s",L,2),
      q("SELECT accounts.* FROM accounts WHERE accounts.id = %s FOR UPDATE",L,1),
      q("-- 2 times\nINSERT INTO ledger_entries (account_id, amount) VALUES (%s, %s)",L),
      q("-- 2 times\nUPDATE accounts SET balance = %s WHERE accounts.id = %s",L,3)],caller=T,d=3),
    f("notify_customer",T,[],caller=T,d=4),
    q("INSERT INTO transfers (source_id, target_id, amount) VALUES (%s, %s, %s)",T),
  ],d=3)]}
json.dump(diff,open("changed.sequence.json","w"),indent=1)
json.dump({"title":"What the fix changed in a transfer",
 "subtitle":"Gold trace test_transfer_debits_source_account · BASE 4f2c9ae → HEAD 9d1e7b3",
 "pageTitle":"Transfer Gold Trace Diff","rootLane":"test",
 "laneLabels":{T:{"sub":"transfers.py"},A:{"sub":"accounts.py"},L:{"sub":"ledger.py"}},
 "notes":[{"after":"authorize_owner","plain":True,"kind":"ok","lane":L,"lines":["new: the owner is checked before any money moves"]}],
 "footer":"Every step shown differs between the two traces, or contains one that does."},open("changed.notes.json","w"),indent=1)

# 3. One test on two versions.
n[0]=0
cmp={"actors":actors([(AU,"auth",1000),(A,"accounts",1000),(DB,"Database",4000)]),
 "rootActions":[
  f("sign_in",AU,[
    f("find_customer",A,[q("SELECT customers.* FROM customers WHERE customers.email = %s",A)],caller=AU),
    f("check_lockout",AU,[q("SELECT count(*) FROM login_attempts WHERE customer_id = %s",AU,1)],caller=AU,d=1),
    f("verify_password",AU,caller=AU),
    f("record_login_attempt",AU,[q("INSERT INTO login_attempts (customer_id, ok) VALUES (%s, %s)",AU,1)],caller=AU,d=1),
    q("DELETE FROM sessions WHERE sessions.customer_id = %s",AU,2),
    f("create_session",AU,[q("INSERT INTO sessions (customer_id, token, expires_at) VALUES (%s, %s, %s)",AU,3)],caller=AU,d=3),
  ],d=3)]}
json.dump(cmp,open("compare.sequence.json","w"),indent=1)
json.dump({"title":"Sign-in, version 0.3.0 and version 0.3.1",
 "subtitle":"test_sign_in_with_password recorded on each version, then compared",
 "pageTitle":"Sign-in Before And After","rootLane":"test",
 "laneLabels":{AU:{"sub":"auth.py"},A:{"sub":"accounts.py"}},
 "notes":[{"after":"sql:DELETE FROM sessions","plain":True,"kind":"error","lines":["0.3.1 no longer ends the customer's other sessions"]}],
 "footer":"Every step shown differs between the two traces, or contains one that does."},open("compare.notes.json","w"),indent=1)
