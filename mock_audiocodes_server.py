#!/usr/bin/env python3
"""
AudioCodes Bot API Mock Server (HTTP-only)

This server simulates the AudioCodes Bot API for testing the AudioHook TCCP integration.
It accepts HTTP POST requests at:
1. /audiocodes/sbcopilotstg/CI/bot - for bot activities (start, transcript, pause, resume, disconnect)
2. /callstatus/sbcopilotstg/event - for call status webhooks

Usage:
    python mock_audiocodes_server.py
    
Environment variables (loaded from .env.mockserver):
    AUDIOCODES_API_KEY - API key for authentication
    PORT - Server port (default: 8081)
    HOST - Server host (default: 0.0.0.0)
"""

import asyncio
import json
import os
import logging
from datetime import datetime
from urllib.parse import parse_qs

from aiohttp import web
from dotenv import load_dotenv

# Load environment from .env.mockserver file
load_dotenv('.env.mockserver')

# Configure logging
logging.basicConfig(
    level=os.getenv('LOG_LEVEL', 'INFO'),
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger('AudioCodesMock')

# Configuration
API_KEY = os.getenv('AUDIOCODES_API_KEY', 'swEDudkFkGaksHNJ5Abkgs0IJnXY2A28')
PORT = int(os.getenv('PORT', '8081'))
HOST = os.getenv('HOST', '0.0.0.0')

# Store received activities
received_activities = []


def verify_api_key(request: web.Request) -> bool:
    """Verify the API key from query params or headers."""
    # Check query params
    query = parse_qs(request.query_string)
    if 'apiKey' in query:
        return query['apiKey'][0] == API_KEY
    
    # Check headers
    if request.headers.get('X-API-Key') == API_KEY:
        return True
    if request.headers.get('Authorization', '').replace('Bearer ', '') == API_KEY:
        return True
    if request.headers.get('Api-Key') == API_KEY:
        return True
    
    return False


async def handle_bot_activities(request: web.Request) -> web.Response:
    """Handle HTTP POST requests for bot activities at /audiocodes/sbcopilotstg/CI/bot"""
    path = request.path
    logger.info(f"Bot activity received: {request.method} {path}")
    
    # Verify API key
    if not verify_api_key(request):
        logger.warning(f"Invalid API key in request to {path}")
        return web.Response(status=401, text='Unauthorized')
    
    # Parse JSON body
    try:
        data = await request.json()
    except Exception as e:
        logger.error(f"Failed to parse JSON body: {e}")
        return web.Response(status=400, text='Invalid JSON')
    
    # Store activity
    received_activities.append({
        'timestamp': datetime.now().isoformat(),
        'path': path,
        'data': data
    })
    
    # Handle different message types
    msg_type = data.get('type', 'unknown')
    conversation = data.get('conversation', 'unknown')
    session_id = data.get('sessionId', 'unknown')
    
    logger.info(f"[{session_id}] Received {msg_type} message for conversation {conversation}")
    
    if msg_type == 'activity':
        payload = data.get('payload', {})
        activities = payload.get('activities', [])
        
        for activity in activities:
            activity_type = activity.get('type')
            activity_name = activity.get('name')
            
            if activity_type == 'event':
                if activity_name == 'start':
                    logger.info(f"[{session_id}] 🟢 Session START event received")
                    params = activity.get('parameters', {})
                    participants = params.get('participants', [])
                    logger.info(f"[{session_id}]   Participants: {len(participants)}")
                    for p in participants:
                        logger.info(f"[{session_id}]     - {p.get('participant')} ({p.get('uriUser')})")
                        
                elif activity_name == 'pause':
                    logger.info(f"[{session_id}] ⏸️  Session PAUSE event received")
                    
                elif activity_name == 'resume':
                    logger.info(f"[{session_id}] ▶️  Session RESUME event received")
                    
                else:
                    logger.info(f"[{session_id}] Event: {activity_name}")
                    
            elif activity_type == 'message':
                text = activity.get('text', '')
                params = activity.get('parameters', {})
                recognition_output = params.get('recognitionOutput', {})
                is_final = recognition_output.get('is_final', False)
                confidence = params.get('confidence', 0)
                participant = params.get('participant', 'unknown')
                
                status = "✅ FINAL" if is_final else "📝 INTERIM"
                logger.info(f"[{session_id}] {status} Transcript from {participant}: '{text}' (confidence: {confidence:.2f})")
                
                # Log word-level details if available
                channel = recognition_output.get('channel', {})
                alternatives = channel.get('alternatives', [])
                if alternatives and alternatives[0].get('words'):
                    words = alternatives[0]['words']
                    logger.info(f"[{session_id}]   Words: {len(words)} word(s)")
        
        # Return acknowledgment
        return web.json_response({
            'type': 'ack',
            'sessionId': session_id,
            'timestamp': datetime.now().isoformat(),
            'payload': {'status': 'received', 'activities_count': len(activities)}
        })
        
    elif msg_type == 'disconnect':
        payload = data.get('payload', {})
        reason = payload.get('reason', 'Unknown')
        reason_code = payload.get('reasonCode', 'unknown')
        logger.info(f"[{session_id}] 🔴 Disconnect received: {reason} ({reason_code})")
        
        return web.json_response({
            'type': 'ack',
            'sessionId': session_id,
            'timestamp': datetime.now().isoformat(),
            'payload': {'status': 'disconnect_acknowledged'}
        })
        
    else:
        logger.info(f"[{session_id}] Unknown message type: {msg_type}")
        return web.json_response({
            'type': 'ack',
            'sessionId': session_id,
            'timestamp': datetime.now().isoformat(),
            'payload': {'status': 'received'}
        })


async def handle_event_webhook(request: web.Request) -> web.Response:
    """Handle HTTP POST requests for call status events at /callstatus/sbcopilotstg/event"""
    path = request.path
    logger.info(f"Event webhook received: {request.method} {path}")
    
    # Verify API key
    if not verify_api_key(request):
        logger.warning(f"Invalid API key in webhook request")
        return web.Response(status=401, text='Unauthorized')
    
    # Parse form data
    try:
        data = await request.post()
    except Exception as e:
        logger.error(f"Failed to parse form data: {e}")
        data = {}
    
    # Extract event details
    call_sid = data.get('CallSid', 'unknown')
    call_status = data.get('CallStatus', 'unknown')
    direction = data.get('Direction', 'unknown')
    leg = data.get('Leg', 'unknown')
    from_num = data.get('From', 'unknown')
    to_num = data.get('To', 'unknown')
    duration = data.get('Duration', 'N/A')
    
    # Map status to emoji
    status_emoji = {
        'initiated': '📞',
        'in-progress': '🔄',
        'completed': '☎️'
    }.get(call_status, '❓')
    
    logger.info(f"{status_emoji} Call Event: {call_status}")
    logger.info(f"   CallSid: {call_sid}")
    logger.info(f"   Direction: {direction}")
    logger.info(f"   Leg: {leg}")
    logger.info(f"   From: {from_num} -> To: {to_num}")
    if duration != 'N/A':
        logger.info(f"   Duration: {duration}s")
    
    return web.Response(status=200, text='OK')


async def handle_health_check(request: web.Request) -> web.Response:
    """Simple health check endpoint."""
    return web.json_response({
        'status': 'healthy',
        'activities_received': len(received_activities),
        'timestamp': datetime.now().isoformat()
    })


async def handle_stats(request: web.Request) -> web.Response:
    """Return statistics about received activities."""
    stats = {
        'total_activities': len(received_activities),
        'activities': received_activities[-50:]  # Last 50 activities
    }
    return web.json_response(stats)


def create_http_app() -> web.Application:
    """Create the HTTP application."""
    app = web.Application()
    
    # Bot activities endpoint (HTTP POST)
    app.router.add_post('/audiocodes/sbcopilotstg/CI/bot', handle_bot_activities)
    # Alternative paths
    app.router.add_post('/audiocodes/{path:.*}/bot', handle_bot_activities)
    
    # Event webhook endpoint (HTTP POST with form data)
    app.router.add_post('/callstatus/sbcopilotstg/event', handle_event_webhook)
    # Alternative paths
    app.router.add_post('/callstatus/{path:.*}/event', handle_event_webhook)
    
    # Health and stats endpoints
    app.router.add_get('/health', handle_health_check)
    app.router.add_get('/stats', handle_stats)
    
    return app


async def start_server():
    """Start the HTTP server."""
    import socket
    
    # Find available port
    actual_port = PORT
    for attempt in range(100):
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.bind((HOST, actual_port))
                break
        except OSError:
            actual_port += 1
    
    logger.info("=" * 60)
    logger.info("AudioCodes Bot API Mock Server (HTTP-only)")
    logger.info("=" * 60)
    logger.info(f"API Key: {API_KEY[:10]}...{API_KEY[-4:]}")
    logger.info(f"Bot activities endpoint: http://{HOST}:{actual_port}/audiocodes/sbcopilotstg/CI/bot")
    logger.info(f"Event webhook endpoint: http://{HOST}:{actual_port}/callstatus/sbcopilotstg/event")
    logger.info(f"Health check: http://{HOST}:{actual_port}/health")
    logger.info(f"Stats: http://{HOST}:{actual_port}/stats")
    logger.info("=" * 60)
    
    # Start HTTP server
    http_app = create_http_app()
    http_runner = web.AppRunner(http_app)
    await http_runner.setup()
    http_site = web.TCPSite(http_runner, HOST, actual_port)
    await http_site.start()
    logger.info(f"HTTP server started on http://{HOST}:{actual_port}")
    
    # Keep running
    try:
        await asyncio.Future()  # Run forever
    except KeyboardInterrupt:
        logger.info("\nShutting down server...")
    finally:
        await http_runner.cleanup()
        logger.info("Server stopped")


if __name__ == '__main__':
    try:
        asyncio.run(start_server())
    except KeyboardInterrupt:
        logger.info("Server stopped by user")
