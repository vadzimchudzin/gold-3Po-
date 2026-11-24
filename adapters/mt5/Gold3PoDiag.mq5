// GOLD-3Po terminal diagnostics. Attach to a XAUUSD chart and read the Experts tab.
#property strict
#property version   "1.00"

input string HealthUrl = "http://127.0.0.1:8787/health";
input int    RequestTimeoutMs = 5000;

void OnInit()
{
   Print("DIAG --- GOLD-3Po terminal diagnostics ---");
   Print("DIAG symbol=", _Symbol, " digits=", _Digits, " point=", DoubleToString(_Point, 5));
   Print("DIAG terminal connected=", TerminalInfoInteger(TERMINAL_CONNECTED),
         " trade_allowed=", TerminalInfoInteger(TERMINAL_TRADE_ALLOWED),
         " build=", TerminalInfoInteger(TERMINAL_BUILD));
   Print("DIAG terminal company=", TerminalInfoString(TERMINAL_COMPANY),
         " name=", TerminalInfoString(TERMINAL_NAME));
   Print("DIAG data_path=", TerminalInfoString(TERMINAL_DATA_PATH));
   Print("DIAG common_path=", TerminalInfoString(TERMINAL_COMMONDATA_PATH));
   Print("DIAG account=", AccountInfoInteger(ACCOUNT_LOGIN),
         " server=", AccountInfoString(ACCOUNT_SERVER),
         " company=", AccountInfoString(ACCOUNT_COMPANY),
         " currency=", AccountInfoString(ACCOUNT_CURRENCY),
         " leverage=1:", AccountInfoInteger(ACCOUNT_LEVERAGE));

   Print("DIAG time_current=", TimeToString(TimeCurrent(), TIME_DATE | TIME_MINUTES),
         " time_gmt=", TimeToString(TimeGMT(), TIME_DATE | TIME_MINUTES),
         " time_local=", TimeToString(TimeLocal(), TIME_DATE | TIME_MINUTES));

   MqlTick tick;
   ResetLastError();
   bool tickOk = SymbolInfoTick(_Symbol, tick);
   Print("DIAG SymbolInfoTick ok=", tickOk, " err=", GetLastError(),
         " bid=", DoubleToString(tick.bid, _Digits),
         " ask=", DoubleToString(tick.ask, _Digits),
         " last=", DoubleToString(tick.last, _Digits),
         " tick_time=", TimeToString(tick.time, TIME_DATE | TIME_MINUTES),
         " tick_msc=", (long)tick.time_msc);

   ResetLastError();
   bool barOk = false;
   datetime barTime = iTime(_Symbol, PERIOD_H1, 0);
   barOk = (barTime > 0);
   Print("DIAG last H1 bar time=", TimeToString(barTime, TIME_DATE | TIME_MINUTES),
         " ok=", barOk, " err=", GetLastError());

   Print("DIAG symbol_select_before=", SymbolInfoInteger(_Symbol, SYMBOL_SELECT),
         " visible=", SymbolInfoInteger(_Symbol, SYMBOL_VISIBLE),
         " trade_mode=", SymbolInfoInteger(_Symbol, SYMBOL_TRADE_MODE),
         " spread=", SymbolInfoInteger(_Symbol, SYMBOL_SPREAD));

   ResetLastError();
   bool selected = SymbolSelect(_Symbol, true);
   Print("DIAG SymbolSelect -> ", selected, " err=", GetLastError());

   Print("DIAG symbols total=", SymbolsTotal(false), " in_market_watch=", SymbolsTotal(true));
   bool foundInWatch = false;
   for(int i = 0; i < SymbolsTotal(true); i++)
      if(SymbolName(i, true) == _Symbol) foundInWatch = true;
   Print("DIAG ", _Symbol, " in_market_watch=", foundInWatch);

   char data[], result[];
   string headers;
   ResetLastError();
   int status = WebRequest("GET", HealthUrl, "", RequestTimeoutMs, data, result, headers);
   int requestError = GetLastError();
   Print("DIAG WebRequest ", HealthUrl, " status=", status, " err=", requestError);
   if(ArraySize(result) > 0)
      Print("DIAG body=", StringSubstr(CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8), 0, 400));

   Print("DIAG --- end ---");
}
