#property strict
#property version "2.20"
#property description "GOLD-3Po RoboForex MT5 bridge: tick history, live quotes and live liquidity-zone drawing on the chart."

input string HealthUrl = "http://127.0.0.1:8787/health";
input string HistoryUrl = "http://127.0.0.1:8787/v1/ingest/mt5/history";
input string LiveBatchUrl = "http://127.0.0.1:8787/v1/ingest/mt5/live-batch";
input string IngestToken = "";          // Optional override; normally read from the app's Common Files token
input bool AppConnectionFeedsLive = true; // The desktop connector owns recent/live ticks when connected
input bool AppConnectionFeedsLive = true; // The desktop connector owns the recent/live feed when enabled.
input int MinIntervalMs = 100;
input int RequestTimeoutMs = 5000;
input int HistoryDays = 30;
input int HistoryBatchSize = 1000;
input int HistoryRetryMinutes = 15;
input bool DrawZones = true;
input string ZonesUrl = "http://127.0.0.1:8787/v1/chart/zones";
input int ZonesRefreshSeconds = 5;
input int ZoneLookbackBars = 200;
input bool UseAppStyle = true;            // colours / line style from GOLD-3Po settings
input color BuyZoneColor = clrRed;         // zones above price (when UseAppStyle=false)
input color SellZoneColor = clrRed;        // zones below price (when UseAppStyle=false)
input ENUM_LINE_STYLE ZoneLineStyle = STYLE_SOLID;
input int ZoneLineWidth = 2;

ulong sequenceNumber = 0;
string sequenceKey = "";
MqlTick pendingTicks[];
ulong pendingSequences[];
bool queueLimitLogged = false;
bool historySynchronized = false;
ulong nextHistoryRetryAt = 0;
MqlTick historyTicks[];
int historyOffset = 0;
ulong historySequence = 0;
ulong historyTotalTicks = 0;
datetime historyCursor = 0;
datetime historyEnd = 0;
datetime historyChunkEnd = 0;
bool historyChunkLoaded = false;
int historyFailures = 0;
ulong historyRejectedTotal = 0;
ulong nextZonesRefreshAt = 0;
string zonesStatusText = "";
int zonesDrawnCount = 0;
string g_ingestToken = "";

// Runtime state for the per-symbol lock, live retry queue and bounded history batches.
string g_bridgeLockKey = "";
double g_bridgeLockStamp = 0.0;
ulong g_nextBridgeLockRefreshAt = 0;
ulong g_nextLiveRetryAt = 0;
int g_liveFailures = 0;
int g_effectiveHistoryBatchSize = 1000;

bool ResolveIngestToken()
{
   // The current desktop-app token is authoritative. This deliberately overrides an
   // older value saved in the EA's chart inputs after a GOLD-3Po reinstall/update.
   const int handle = FileOpen("GOLD3PO\\bridge-token.txt", FILE_READ | FILE_TXT | FILE_ANSI | FILE_COMMON);
   if(handle != INVALID_HANDLE)
   {
      string sharedToken = FileReadString(handle);
      FileClose(handle);
      StringTrimLeft(sharedToken);
      StringTrimRight(sharedToken);
      if(StringLen(sharedToken) >= 24)
      {
         g_ingestToken = sharedToken;
         return true;
      }
      Print("GOLD-3Po: shared bridge token is present but invalid; checking the explicit IngestToken override.");
   }

   // Explicit override is retained for a standalone EA connected to a remote API.
   g_ingestToken = IngestToken;
   StringTrimLeft(g_ingestToken);
   StringTrimRight(g_ingestToken);
   if(StringLen(g_ingestToken) >= 24)
      return true;

   Print("GOLD-3Po: bridge token is not available. Start GOLD-3Po or provide IngestToken for a standalone remote API.");
   return false;
}

string TickStamp(const long timeMsc)
{
   datetime seconds = (datetime)(timeMsc / 1000);
   string stamp = TimeToString(seconds, TIME_DATE | TIME_SECONDS);
   StringReplace(stamp, ".", "-");
   StringReplace(stamp, " ", "T");
   return stamp + StringFormat(".%03dZ", (int)(timeMsc % 1000));
}

int PostJson(const string url, const string body, string &response)
{
   response = "";
   char data[];
   int copied = StringToCharArray(body, data, 0, WHOLE_ARRAY, CP_UTF8);
   if(copied > 0) ArrayResize(data, copied - 1);
   char result[];
   string responseHeaders;
   string headers = "Content-Type: application/json\r\nAuthorization: Bearer " + g_ingestToken +"\r\n";
   int status = WebRequest("POST", url, headers, RequestTimeoutMs, data, result, responseHeaders);
   if(ArraySize(result) > 0) response = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);
   if(status < 200 || status >= 300)
      Print("GOLD-3Po bridge: POST failed status=", status, " error=", GetLastError(), " url=", url);
   return status;
}

long JsonLong(const string json, const string key)
{
   string pattern = "\"" + key + "\":";
   int start = StringFind(json, pattern);
   if(start < 0) return -1;
   start += StringLen(pattern);
   int end = start;
   int len = StringLen(json);
   while(end < len)
   {
      ushort ch = StringGetCharacter(json, end);
      if(ch >= '0' && ch <= '9') end++; else break;
   }
   if(end == start) return -1;
   return (long)StringToInteger(StringSubstr(json, start, end - start));
}

bool SendHistoryBatch(MqlTick &ticks[], const int first, const int count, ulong &sequenceCursor, string &response)
{
   string body = "{\"source\":\"mt5\",\"symbol\":\"" + _Symbol + "\",\"ticks\":[";
   for(int i=0; i<count; i++)
   {
      MqlTick tick = ticks[first+i];
      sequenceCursor++;
      double lastPrice = tick.last > 0 ? tick.last : (tick.bid + tick.ask) / 2.0;
      string eventId = StringFormat("%s-%I64d-%.10f-%.10f-%.10f-%I64u-%.4f-%u", _Symbol, tick.time_msc, tick.bid, tick.ask, lastPrice, tick.volume, tick.volume_real, tick.flags);
      if(i > 0) body += ",";
      body += StringFormat(
         "{\"timestamp\":\"%s\",\"sequence\":%I64u,\"eventId\":\"%s\",\"bid\":%.10f,\"ask\":%.10f,\"last\":%.10f,\"tickVolume\":%I64u,\"realVolume\":%.4f,\"flags\":%u}",
         TickStamp(tick.time_msc), sequenceCursor, eventId, tick.bid, tick.ask, lastPrice, tick.volume, tick.volume_real, tick.flags
      );
   }
   body += "]}";
   int status = PostJson(HistoryUrl, body, response);
   return status >= 200 && status < 300;
}

void StartHistorySync()
{
   int days = MathMax(1, MathMin(HistoryDays, 90));
   historyEnd = TimeGMT() - (AppConnectionFeedsLive ? 8 * 60 * 60 : 0);
   // Avoid duplicating the recent window already supplied by the desktop connector.
   if(AppConnectionFeedsLive) historyEnd -= 8 * 60 * 60;
   historyCursor = historyEnd - days * 86400;
   historySequence = 0;
   historyTotalTicks = 0;
   historyOffset = 0;
   historyChunkLoaded = false;
   ArrayFree(historyTicks);
   historySynchronized = false;
   Print("GOLD-3Po: scheduled up to ", days, " days of broker history. Live collection starts immediately.");
}

void ScheduleHistoryRetry()
{
   historyFailures++;
   ulong delayMs = 1000;
   int exponent = MathMin(historyFailures - 1, 7);
   for(int i=0; i<exponent; i++) delayMs *= 2;
   if(historyFailures >= 8) delayMs = (ulong)MathMax(1, HistoryRetryMinutes) * 60000;
   nextHistoryRetryAt = GetTickCount64() + delayMs;
}

void ProcessHistorySync()
{
   if(historySynchronized) return;
   int batchSize = g_effectiveHistoryBatchSize;

   if(!historyChunkLoaded)
   {
      if(historyCursor >= historyEnd)
      {
         historySynchronized = true;
         Print("GOLD-3Po: history sync completed. Ticks uploaded: ", historyTotalTicks, ", rejected by API: ", historyRejectedTotal, ". Repeated ticks are de-duplicated by the API.");
         return;
      }

      historyChunkEnd = (datetime)MathMin((long)historyEnd, (long)(historyCursor + 3600));
      MqlTick copiedTicks[];
      ulong fromMsc = (ulong)historyCursor * 1000;
      ulong toMsc = (ulong)historyChunkEnd * 1000 - 1;
      ResetLastError();
      int copied = CopyTicksRange(_Symbol, copiedTicks, COPY_TICKS_ALL, fromMsc, toMsc);
      if(copied < 0)
      {
         Print("GOLD-3Po: history chunk unavailable at ", TimeToString(historyCursor), " error=", GetLastError(), ". Retry scheduled.");
         ScheduleHistoryRetry();
         return;
      }

      ArrayFree(historyTicks);
      if(copied > 0)
      {
         ArrayResize(historyTicks, copied);
         ArrayCopy(historyTicks, copiedTicks, 0, 0, copied);
      }
      historyOffset = 0;
      historyChunkLoaded = true;
   }

   int total = ArraySize(historyTicks);
   if(historyOffset < total)
   {
      int count = MathMin(batchSize, total - historyOffset);
      string response;
      bool sent = SendHistoryBatch(historyTicks, historyOffset, count, historySequence, response);
      long rejectedNow = JsonLong(response, "rejected");
      if(rejectedNow > 0)
      {
         historyRejectedTotal += (ulong)rejectedNow;
         Print("GOLD-3Po: API rejected ", rejectedNow, " historical ticks in this batch.");
      }
      if(!sent && rejectedNow <= 0)
      {
         Print("GOLD-3Po: history upload failed; the same batch will be retried idempotently.");
         ScheduleHistoryRetry();
         return;
      }
      historyOffset += count;
      historyTotalTicks += (ulong)count;
      historyFailures = 0;
   }

   if(historyOffset >= total)
   {
      ArrayFree(historyTicks);
      historyOffset = 0;
      historyChunkLoaded = false;
      historyCursor = historyChunkEnd;
   }
   nextHistoryRetryAt = GetTickCount64();
}

bool FlushLiveBatch()
{
   int available = ArraySize(pendingTicks);
   if(available <= 0) return true;
   int count = MathMin(1000, available);
   string body = "{\"source\":\"mt5\",\"symbol\":\"" + _Symbol + "\",\"ticks\":[";
   for(int i=0; i<count; i++)
   {
      MqlTick tick = pendingTicks[i];
      double lastPrice = tick.last > 0 ? tick.last : (tick.bid + tick.ask) / 2.0;
      string eventId = StringFormat("LIVE-%I64u", pendingSequences[i]);
      if(i > 0) body += ",";
      body += StringFormat(
         "{\"timestamp\":\"%s\",\"sequence\":%I64u,\"eventId\":\"%s\",\"bid\":%.10f,\"ask\":%.10f,\"last\":%.10f,\"tickVolume\":%I64u,\"realVolume\":%.4f,\"flags\":%u}",
         TickStamp(tick.time_msc), pendingSequences[i], eventId, tick.bid, tick.ask, lastPrice, tick.volume, tick.volume_real, tick.flags
      );
   }
   body += "]}";
   string response;
   int status = PostJson(LiveBatchUrl, body, response);
   if(status == 409)
   {
      // Sequence collision (e.g. another EA instance or a restart): rebase above the server cursor.
      long lastAccepted = JsonLong(response, "lastAcceptedSequence");
      if(lastAccepted >= 0)
      {
         if((double)lastAccepted > GlobalVariableGet(sequenceKey)) GlobalVariableSet(sequenceKey, (double)lastAccepted);
         sequenceNumber = (ulong)MathMax((double)sequenceNumber, (double)lastAccepted);
         for(int i=0; i<available; i++)
         {
            sequenceNumber++;
            pendingSequences[i] = sequenceNumber;
         }
         Print("GOLD-3Po: live sequence rebased above ", lastAccepted, "; batch will be resent.");
      }
      return false;
   }
   if(status == 401 || status == 403 || status == 422)
   {
      Print("GOLD-3Po: permanent live-batch rejection (HTTP ", status, "). Dropping ", count, " ticks to keep history and zones running. Check the ingest token.");
   }
   else if(status < 200 || status >= 300)
   {
      return false; // transient failure: keep the queue for retry
   }
   for(int i=count; i<available; i++)
   {
      pendingTicks[i-count] = pendingTicks[i];
      pendingSequences[i-count] = pendingSequences[i];
   }
   ArrayResize(pendingTicks, available-count);
   ArrayResize(pendingSequences, available-count);
   return true;
}

ulong NextSequence()
{
   for(int attempt=0; attempt<32; attempt++)
   {
      double current = GlobalVariableGet(sequenceKey);
      double candidate = MathMax(current, (double)sequenceNumber) + 1.0;
      if(candidate >= 9007199254740991.0) return 0;
      if(GlobalVariableSetOnCondition(sequenceKey, candidate, current))
      {
         sequenceNumber = (ulong)candidate;
         return sequenceNumber;
      }
   }
   Print("GOLD-3Po: could not reserve a unique live sequence number.");
   return 0;
}

//--- Liquidity-zone drawing -------------------------------------------------

bool GetJson(const string url, string &response)
{
   char data[];
   ArrayResize(data, 0);
   char result[];
   string responseHeaders;
   string headers = "Authorization: Bearer " + g_ingestToken +"\r\n";
   ResetLastError();
   int status = WebRequest("GET", url, headers, RequestTimeoutMs, data, result, responseHeaders);
   if(status == 200)
   {
      response = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);
      return true;
   }
   if(status == 402)
   {
      response = "license_required";
      return false;
   }
   Print("GOLD-3Po zones: GET failed status=", status, " error=", GetLastError());
   response = "";
   return false;
}

string JsonStringField(const string obj, const string key)
{
   string pattern = "\"" + key + "\":\"";
   int start = StringFind(obj, pattern);
   if(start < 0) return "";
   start += StringLen(pattern);
   int end = StringFind(obj, "\"", start);
   if(end < 0) return "";
   return StringSubstr(obj, start, end - start);
}

double JsonNumberField(const string obj, const string key)
{
   string pattern = "\"" + key + "\":";
   int start = StringFind(obj, pattern);
   if(start < 0) return EMPTY_VALUE;
   start += StringLen(pattern);
   int end = start;
   int len = StringLen(obj);
   while(end < len)
   {
      ushort ch = StringGetCharacter(obj, end);
      if((ch >= '0' && ch <= '9') || ch == '-' || ch == '+' || ch == '.' || ch == 'e' || ch == 'E') end++;
      else break;
   }
   if(end == start) return EMPTY_VALUE;
   return StringToDouble(StringSubstr(obj, start, end - start));
}

bool JsonBoolField(const string obj, const string key, const bool fallback)
{
   string pattern = "\"" + key + "\":";
   int start = StringFind(obj, pattern);
   if(start < 0) return fallback;
   start += StringLen(pattern);
   if(StringSubstr(obj, start, 4) == "true") return true;
   if(StringSubstr(obj, start, 5) == "false") return false;
   return fallback;
}

int HexNibble(const ushort c)
{
   if(c >= '0' && c <= '9') return c - '0';
   if(c >= 'A' && c <= 'F') return c - 'A' + 10;
   if(c >= 'a' && c <= 'f') return c - 'a' + 10;
   return -1;
}

// "#RRGGBB" -> MQL color (0x00BBGGRR); fallback when malformed.
color HexToColor(const string text, const color fallback)
{
   if(StringLen(text) != 7 || StringGetCharacter(text, 0) != '#') return fallback;
   int rgb[3];
   for(int k = 0; k < 3; k++)
   {
      int hi = HexNibble(StringGetCharacter(text, 1 + k * 2));
      int lo = HexNibble(StringGetCharacter(text, 2 + k * 2));
      if(hi < 0 || lo < 0) return fallback;
      rgb[k] = hi * 16 + lo;
   }
   return (color)(rgb[0] | (rgb[1] << 8) | (rgb[2] << 16));
}

ENUM_LINE_STYLE LineStyleFromText(const string text, const ENUM_LINE_STYLE fallback)
{
   if(text == "solid") return STYLE_SOLID;
   if(text == "dash") return STYLE_DASH;
   if(text == "dot") return STYLE_DOT;
   if(text == "dashdot") return STYLE_DASHDOT;
   if(text == "dashdotdot") return STYLE_DASHDOTDOT;
   return fallback;
}

color BlendColor(const color fg, const color bg, const double share)
{
   uint a = (uint)fg, b = (uint)bg;
   int r = (int)MathRound((a & 0xFF) * share + (b & 0xFF) * (1.0 - share));
   int g = (int)MathRound(((a >> 8) & 0xFF) * share + ((b >> 8) & 0xFF) * (1.0 - share));
   int bl = (int)MathRound(((a >> 16) & 0xFF) * share + ((b >> 16) & 0xFF) * (1.0 - share));
   return (color)(r | (g << 8) | (bl << 16));
}

void DeleteZoneObjects()
{
   ObjectsDeleteAll(0, "G3P_");
}

void SetZonesStatus(const string text)
{
   zonesStatusText = text;
   string name = "G3P_STATUS";
   if(ObjectFind(0, name) < 0) ObjectCreate(0, name, OBJ_LABEL, 0, 0, 0);
   ObjectSetInteger(0, name, OBJPROP_CORNER, CORNER_LEFT_UPPER);
   ObjectSetInteger(0, name, OBJPROP_XDISTANCE, 10);
   ObjectSetInteger(0, name, OBJPROP_YDISTANCE, 20);
   ObjectSetInteger(0, name, OBJPROP_COLOR, clrSilver);
   ObjectSetInteger(0, name, OBJPROP_FONTSIZE, 8);
   ObjectSetString(0, name, OBJPROP_FONT, "Consolas");
   ObjectSetString(0, name, OBJPROP_TEXT, text);
}

void RefreshZones()
{
   string response;
   string url = ZonesUrl + "?symbol=" + _Symbol + "&source=mt5";
   if(!GetJson(url, response))
   {
      DeleteZoneObjects();
      zonesDrawnCount = 0;
      if(response == "license_required") SetZonesStatus("GOLD-3Po: licence required — activate in the app to see zones");
      else SetZonesStatus("GOLD-3Po zones: API unreachable");
      ChartRedraw(0);
      return;
   }
   int zonesStart = StringFind(response, "\"zones\":[");
   if(zonesStart < 0)
   {
      DeleteZoneObjects();
      zonesDrawnCount = 0;
      SetZonesStatus("GOLD-3Po zones: no zone data yet");
      ChartRedraw(0);
      return;
   }
   zonesStart += StringLen("\"zones\":[");
   int zonesEnd = StringFind(response, "]", zonesStart);
   if(zonesEnd < 0) return;
   string zonesJson = StringSubstr(response, zonesStart, zonesEnd - zonesStart);

   // Drawing style: GOLD-3Po settings (red solid lines by default), or this EA's inputs.
   color buyColor = BuyZoneColor, sellColor = SellZoneColor;
   ENUM_LINE_STYLE lineStyle = ZoneLineStyle;
   int lineWidth = (int)MathMax(1, MathMin(5, ZoneLineWidth));
   bool fill = false, showLabels = true, showStrength = true;
   int styleStart = StringFind(response, "\"style\":{");
   if(UseAppStyle && styleStart >= 0)
   {
      int styleEnd = StringFind(response, "}", styleStart);
      string styleJson = StringSubstr(response, styleStart, styleEnd - styleStart + 1);
      buyColor = HexToColor(JsonStringField(styleJson, "buyColor"), buyColor);
      sellColor = HexToColor(JsonStringField(styleJson, "sellColor"), sellColor);
      lineStyle = LineStyleFromText(JsonStringField(styleJson, "lineStyle"), lineStyle);
      double w = JsonNumberField(styleJson, "lineWidth");
      if(w != EMPTY_VALUE && w >= 1 && w <= 5) lineWidth = (int)w;
      fill = JsonBoolField(styleJson, "fill", fill);
      showLabels = JsonBoolField(styleJson, "showLabels", showLabels);
      showStrength = JsonBoolField(styleJson, "showStrength", showStrength);
   }
   if(lineStyle != STYLE_SOLID) lineWidth = 1; // MT5 draws dashes only at width 1
   color background = (color)ChartGetInteger(0, CHART_COLOR_BACKGROUND);

   DeleteZoneObjects();
   zonesDrawnCount = 0;
   int buyCount = 0, sellCount = 0;
   int availableBars = Bars(_Symbol, _Period);
   int lookback = (int)MathMin(ZoneLookbackBars, MathMax(10, availableBars - 1));
   datetime timeLeft = iTime(_Symbol, _Period, lookback);
   datetime timeRight = TimeCurrent() + PeriodSeconds() * 20;
   if(timeLeft <= 0) timeLeft = TimeCurrent() - PeriodSeconds() * lookback;

   int cursor = 0;
   while(true)
   {
      int objStart = StringFind(zonesJson, "{", cursor);
      if(objStart < 0) break;
      int objEnd = StringFind(zonesJson, "}", objStart);
      if(objEnd < 0) break;
      string obj = StringSubstr(zonesJson, objStart, objEnd - objStart + 1);
      cursor = objEnd + 1;

      string id = JsonStringField(obj, "id");
      string side = JsonStringField(obj, "side");
      double low = JsonNumberField(obj, "low");
      double high = JsonNumberField(obj, "high");
      double strength = JsonNumberField(obj, "strength");
      string distance = JsonStringField(obj, "distance");
      string state = JsonStringField(obj, "state");
      string label = JsonStringField(obj, "label");
      if(id == "" || low == EMPTY_VALUE || high == EMPTY_VALUE || high <= low) continue;

      color zoneColor = (side == "buy") ? buyColor : sellColor;
      string rectName = "G3P_ZONE_" + id;
      if(ObjectCreate(0, rectName, OBJ_RECTANGLE, 0, timeLeft, low, timeRight, high))
      {
         ObjectSetInteger(0, rectName, OBJPROP_COLOR, fill ? BlendColor(zoneColor, background, 0.22) : zoneColor);
         ObjectSetInteger(0, rectName, OBJPROP_STYLE, lineStyle);
         ObjectSetInteger(0, rectName, OBJPROP_WIDTH, lineWidth);
         ObjectSetInteger(0, rectName, OBJPROP_FILL, fill);
         ObjectSetInteger(0, rectName, OBJPROP_BACK, true);
         ObjectSetInteger(0, rectName, OBJPROP_SELECTABLE, false);
         ObjectSetString(0, rectName, OBJPROP_TOOLTIP, "GOLD-3Po " + side + "-side liquidity · strength " + DoubleToString(strength, 2) + " · " + state);
      }
      string labelName = "G3P_LBL_" + id;
      double midPrice = (low + high) / 2.0;
      if(fill)
      {
         // A filled rectangle has no outline: draw the zone edges as lines on top.
         for(int edge = 0; edge < 2; edge++)
         {
            string lineName = "G3P_EDGE_" + id + (edge == 0 ? "_L" : "_H");
            double price = edge == 0 ? low : high;
            if(ObjectCreate(0, lineName, OBJ_TREND, 0, timeLeft, price, timeRight, price))
            {
               ObjectSetInteger(0, lineName, OBJPROP_COLOR, zoneColor);
               ObjectSetInteger(0, lineName, OBJPROP_STYLE, lineStyle);
               ObjectSetInteger(0, lineName, OBJPROP_WIDTH, lineWidth);
               ObjectSetInteger(0, lineName, OBJPROP_RAY_RIGHT, false);
               ObjectSetInteger(0, lineName, OBJPROP_SELECTABLE, false);
            }
         }
      }
      string caption = " " + (label != "" ? label : side + " LQ") + " · " + state + (showStrength ? " · " + IntegerToString((int)MathRound(strength * 100)) + "%" : "") + " " + distance;
      if(showLabels && ObjectCreate(0, labelName, OBJ_TEXT, 0, timeRight, midPrice))
      {
         ObjectSetString(0, labelName, OBJPROP_TEXT, caption);
         ObjectSetInteger(0, labelName, OBJPROP_COLOR, zoneColor);
         ObjectSetInteger(0, labelName, OBJPROP_FONTSIZE, 8);
         ObjectSetString(0, labelName, OBJPROP_FONT, "Consolas");
         ObjectSetInteger(0, labelName, OBJPROP_ANCHOR, ANCHOR_LEFT);
         ObjectSetInteger(0, labelName, OBJPROP_SELECTABLE, false);
      }
      zonesDrawnCount++;
      if(side == "buy") buyCount++; else sellCount++;
   }
   SetZonesStatus(StringFormat("GOLD-3Po zones: %d (%d buy / %d sell) · %s", zonesDrawnCount, buyCount, sellCount, TimeToString(TimeCurrent(), TIME_SECONDS)));
   ChartRedraw(0);
}

void OnTick()
{
   if(AppConnectionFeedsLive) return; // The desktop connector already sends the live feed.
   MqlTick tick;
   if(!SymbolInfoTick(_Symbol, tick) || tick.bid <= 0 || tick.ask < tick.bid) return;
   int queued = ArraySize(pendingTicks);
   if(queued >= 20000)
   {
      if(!queueLimitLogged)
      {
         Print("GOLD-3Po: live buffer is full; incoming ticks are being skipped until delivery recovers.");
         queueLimitLogged = true;
      }
      return;
   }
   ulong nextSequence = NextSequence();
   if(nextSequence == 0) return;
   if(ArrayResize(pendingTicks, queued+1) != queued+1) return;
   if(ArrayResize(pendingSequences, queued+1) != queued+1)
   {
      ArrayResize(pendingTicks, queued);
      return;
   }
   pendingTicks[queued] = tick;
   pendingSequences[queued] = nextSequence;
   if(queued == 0) queueLimitLogged = false;
}

bool AcquireBridgeLock()
{
   g_bridgeLockKey = "G3P_BRIDGE_LOCK_" + _Symbol;
   if(!GlobalVariableCheck(g_bridgeLockKey)) GlobalVariableTemp(g_bridgeLockKey);
   if(!GlobalVariableCheck(g_bridgeLockKey))
   {
      Print("GOLD-3Po: could not create the per-symbol Bridge lock.");
      return false;
   }
   double previous = GlobalVariableGet(g_bridgeLockKey);
   double now = (double)TimeGMT();
   if(previous > 0 && now - previous < 120)
   {
      Print("GOLD-3Po: another Bridge instance already owns ", _Symbol, ". Keep one Gold3PoBridge on this symbol; this copy will stop.");
      return false;
   }
   if(!GlobalVariableSetOnCondition(g_bridgeLockKey, now, previous))
   {
      Print("GOLD-3Po: another chart acquired the ", _Symbol, " Bridge lock. Remove duplicate Gold3PoBridge instances.");
      return false;
   }
   g_bridgeLockStamp = now;
   g_nextBridgeLockRefreshAt = GetTickCount64() + 30000;
   return true;
}

bool RefreshBridgeLock()
{
   double now = (double)TimeGMT();
   if(!GlobalVariableSetOnCondition(g_bridgeLockKey, now, g_bridgeLockStamp)) return false;
   g_bridgeLockStamp = now;
   g_nextBridgeLockRefreshAt = GetTickCount64() + 30000;
   return true;
}

void ReleaseBridgeLock()
{
   if(g_bridgeLockKey != "" && g_bridgeLockStamp > 0 && GlobalVariableCheck(g_bridgeLockKey))
      GlobalVariableSetOnCondition(g_bridgeLockKey, 0.0, g_bridgeLockStamp);
   g_bridgeLockStamp = 0.0;
}

bool CheckLocalApi()
{
   char data[], result[];
   ArrayResize(data, 0);
   string responseHeaders;
   ResetLastError();
   int status = WebRequest("GET", HealthUrl, "", RequestTimeoutMs, data, result, responseHeaders);
   int requestError = GetLastError();
   string body = ArraySize(result) > 0 ? CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8) : "";
   if(status != 200 || StringFind(body, "\"status\":\"ok\"") < 0)
   {
      Print("GOLD-3Po: local API preflight failed. status=", status, " MQL5 error=", requestError, " URL=", HealthUrl);
      if(requestError == 5203 || requestError == 4014)
         Print("GOLD-3Po: start GOLD-3Po first and allow http://127.0.0.1:8787 in MT5 Tools > Options > Expert Advisors > WebRequest.");
      else if(status >= 400 && body != "")
         Print("GOLD-3Po: API health response: ", StringSubstr(body, 0, 240));
      return false;
   }
   return true;
}
int OnInit()
{
   if(!ResolveIngestToken())
      return INIT_PARAMETERS_INCORRECT;
   if(!AcquireBridgeLock()) return INIT_FAILED;
   if(!CheckLocalApi())
   {
      ReleaseBridgeLock();
      return INIT_FAILED;
   }
   g_effectiveHistoryBatchSize = MathMax(50, MathMin(HistoryBatchSize, 1000));
   sequenceKey = "G3P_SEQ_" + _Symbol;
   ulong epochSeed = (ulong)TimeGMT() * 1000;
   if(!GlobalVariableCheck(sequenceKey)) GlobalVariableSet(sequenceKey, (double)epochSeed);
   double storedSequence = GlobalVariableGet(sequenceKey);
   if(storedSequence < (double)epochSeed)
   {
      GlobalVariableSetOnCondition(sequenceKey, (double)epochSeed, storedSequence);
      storedSequence = GlobalVariableGet(sequenceKey);
   }
   sequenceNumber = (ulong)storedSequence;
   if(!SymbolSelect(_Symbol, true))
   {
      ReleaseBridgeLock();
      return INIT_FAILED;
   }
   StartHistorySync();
   nextHistoryRetryAt = GetTickCount64();
   nextZonesRefreshAt = GetTickCount64() + 2000;
   g_nextLiveRetryAt = GetTickCount64();
   if(!EventSetMillisecondTimer(MathMax(250, MinIntervalMs)))
   {
      Print("GOLD-3Po: could not start the MT5 bridge timer. Error=", GetLastError());
      ReleaseBridgeLock();
      return INIT_FAILED;
   }
   Print("GOLD-3Po bridge ready for ", _Symbol, ". One instance owns history and zone drawing; AppConnectionFeedsLive=", AppConnectionFeedsLive, ".");
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
   EventKillTimer();
   ReleaseBridgeLock();
   DeleteZoneObjects();
   ChartRedraw(0);
}

void OnTimer()
{
   ulong nowMs = GetTickCount64();
   if(nowMs >= g_nextBridgeLockRefreshAt && !RefreshBridgeLock())
   {
      Print("GOLD-3Po: Bridge lock was lost for ", _Symbol, ". This duplicate instance will stop.");
      ExpertRemove();
      return;
   }
   if(!AppConnectionFeedsLive && ArraySize(pendingTicks) > 0 && nowMs >= g_nextLiveRetryAt)
   {
      if(!FlushLiveBatch())
      {
         g_liveFailures++;
         int exponent = MathMin(g_liveFailures - 1, 5);
         ulong delayMs = (ulong)MathMin(60000, 1000 * (1 << exponent));
         g_nextLiveRetryAt = nowMs + delayMs;
         Print("GOLD-3Po: pending live ticks retained; next retry in ", delayMs / 1000, " s.");
      }
      else
      {
         g_liveFailures = 0;
         g_nextLiveRetryAt = nowMs;
      }
   }
   if(!historySynchronized && nowMs >= nextHistoryRetryAt)
      ProcessHistorySync();
   if(DrawZones && nowMs >= nextZonesRefreshAt)
   {
      RefreshZones();
      nextZonesRefreshAt = nowMs + (ulong)MathMax(1, ZonesRefreshSeconds) * 1000;
   }
}
