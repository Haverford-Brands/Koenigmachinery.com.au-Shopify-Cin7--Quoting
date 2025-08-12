import os
import logging
import uuid
from datetime import datetime
from typing import List, Optional, Dict, Any
from decimal import Decimal

from fastapi import FastAPI, HTTPException, status, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, validator
from motor.motor_asyncio import AsyncIOMotorClient
from pymongo.errors import DuplicateKeyError
import httpx
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)

# MongoDB connection
MONGO_URL = os.getenv("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.getenv("DB_NAME", "quoting_system")

client = AsyncIOMotorClient(MONGO_URL)
database = client[DB_NAME]

# FastAPI app initialization
app = FastAPI(
    title="Koenig Machinery Quoting System",
    description="Integration with Shopify and Cin7 Omni for laser machine quotes",
    version="1.0.0"
)

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("CORS_ORIGINS", "*").split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Shopify configuration
SHOPIFY_CONFIG = {
    "store_url": os.getenv("SHOPIFY_STORE_URL"),
    "api_key": os.getenv("SHOPIFY_API_KEY"), 
    "secret_key": os.getenv("SHOPIFY_SECRET_KEY"),
    "access_token": os.getenv("SHOPIFY_ACCESS_TOKEN"),
    "api_version": os.getenv("SHOPIFY_API_VERSION", "2024-01")
}

# Cin7 Omni configuration
CIN7_CONFIG = {
    "base_url": os.getenv("CIN7_API_BASE_URL"),
    "username": os.getenv("CIN7_API_USERNAME"),
    "api_key": os.getenv("CIN7_API_KEY")
}

# Pydantic models
class QuoteLineItem(BaseModel):
    code: str = Field(..., description="Product variant code")
    name: str = Field(..., description="Product variant name")
    qty: int = Field(..., gt=0, description="Quantity")
    unit_price: Optional[Decimal] = Field(None, description="Unit price")
    
    @validator('qty')
    def validate_quantity(cls, v):
        if v <= 0:
            raise ValueError('Quantity must be greater than zero')
        return v

class QuoteCustomer(BaseModel):
    first_name: str = Field(..., min_length=1)
    last_name: str = Field(..., min_length=1)
    email: str = Field(..., regex=r'^[^@]+@[^@]+\.[^@]+$')
    business_name: str = Field(..., min_length=1)
    phone: Optional[str] = None
    
    # Address information
    address_line1: str = Field(..., min_length=1)
    address_line2: Optional[str] = None
    city: str = Field(..., min_length=1)
    state: str = Field(..., min_length=1)
    postal_code: str = Field(..., min_length=1)
    country: str = Field(default="Australia")

class QuoteRequest(BaseModel):
    product_id: str = Field(..., description="Shopify product ID")
    product_handle: str = Field(..., description="Shopify product handle")
    product_title: str = Field(..., description="Product title")
    line_items: List[QuoteLineItem] = Field(..., min_items=1, max_items=10)
    customer: QuoteCustomer
    discount_code: Optional[str] = None
    notes: Optional[str] = None

class QuoteResponse(BaseModel):
    quote_id: str
    shopify_draft_order_id: Optional[str] = None
    cin7_quote_id: Optional[str] = None
    status: str
    created_at: datetime
    customer_name: str
    total_items: int
    message: str

# HTTP Client for external APIs
class HTTPClient:
    def __init__(self):
        self.client = httpx.AsyncClient(timeout=30.0)
    
    async def close(self):
        await self.client.aclose()

http_client = HTTPClient()

# Shopify API functions
class ShopifyClient:
    def __init__(self):
        self.store_url = SHOPIFY_CONFIG["store_url"]
        self.access_token = SHOPIFY_CONFIG["access_token"]
        self.api_version = SHOPIFY_CONFIG["api_version"]
        self.headers = {
            "X-Shopify-Access-Token": self.access_token,
            "Content-Type": "application/json"
        }
    
    async def get_product(self, product_id: str) -> Dict[str, Any]:
        """Fetch product details from Shopify"""
        url = f"{self.store_url}/admin/api/{self.api_version}/products/{product_id}.json"
        
        try:
            response = await http_client.client.get(url, headers=self.headers)
            response.raise_for_status()
            data = response.json()
            return data.get("product", {})
        except Exception as e:
            logger.error(f"Error fetching product {product_id}: {str(e)}")
            raise HTTPException(status_code=500, detail=f"Failed to fetch product: {str(e)}")
    
    async def validate_discount_code(self, discount_code: str) -> Dict[str, Any]:
        """Validate discount code with Shopify"""
        url = f"{self.store_url}/admin/api/{self.api_version}/discount_codes.json"
        
        try:
            response = await http_client.client.get(
                url, 
                headers=self.headers,
                params={"code": discount_code}
            )
            response.raise_for_status()
            data = response.json()
            return data.get("discount_codes", [])
        except Exception as e:
            logger.warning(f"Error validating discount code {discount_code}: {str(e)}")
            return []
    
    async def create_draft_order(self, quote_data: QuoteRequest) -> Dict[str, Any]:
        """Create draft order in Shopify"""
        url = f"{self.store_url}/admin/api/{self.api_version}/draft_orders.json"
        
        # Build line items for Shopify
        line_items = []
        for item in quote_data.line_items:
            line_items.append({
                "title": item.name,
                "price": str(item.unit_price) if item.unit_price else "0.00",
                "quantity": item.qty,
                "sku": item.code,
                "custom": True
            })
        
        # Build customer data
        customer_data = {
            "first_name": quote_data.customer.first_name,
            "last_name": quote_data.customer.last_name,
            "email": quote_data.customer.email,
            "phone": quote_data.customer.phone,
        }
        
        # Build shipping address
        shipping_address = {
            "first_name": quote_data.customer.first_name,
            "last_name": quote_data.customer.last_name,
            "company": quote_data.customer.business_name,
            "address1": quote_data.customer.address_line1,
            "address2": quote_data.customer.address_line2,
            "city": quote_data.customer.city,
            "province": quote_data.customer.state,
            "zip": quote_data.customer.postal_code,
            "country": quote_data.customer.country
        }
        
        draft_order_data = {
            "draft_order": {
                "line_items": line_items,
                "customer": customer_data,
                "shipping_address": shipping_address,
                "billing_address": shipping_address,
                "use_customer_default_address": False,
                "note": f"Quote generated from product: {quote_data.product_title}. Customer notes: {quote_data.notes or 'None'}",
                "tags": "quote,laser-machine",
                "invoice_sent_at": None,  # Don't send invoice yet
                "completed_at": None      # Keep as draft
            }
        }
        
        # Add discount if provided and valid
        if quote_data.discount_code:
            discount_codes = await self.validate_discount_code(quote_data.discount_code)
            if discount_codes:
                draft_order_data["draft_order"]["applied_discount"] = {
                    "title": quote_data.discount_code,
                    "value_type": "percentage",
                    "value": "10.0"  # Default 10% - adjust based on actual discount
                }
        
        try:
            response = await http_client.client.post(
                url, 
                headers=self.headers,
                json=draft_order_data
            )
            response.raise_for_status()
            data = response.json()
            return data.get("draft_order", {})
        except Exception as e:
            logger.error(f"Error creating draft order: {str(e)}")
            raise HTTPException(status_code=500, detail=f"Failed to create draft order: {str(e)}")

# Cin7 Omni API functions
class Cin7Client:
    def __init__(self):
        self.base_url = CIN7_CONFIG["base_url"]
        self.username = CIN7_CONFIG["username"] 
        self.api_key = CIN7_CONFIG["api_key"]
        self.auth = (self.username, self.api_key)
        self.headers = {
            "Content-Type": "application/json",
            "Accept": "application/json"
        }
    
    async def create_quote(self, quote_data: QuoteRequest) -> Dict[str, Any]:
        """Create quote in Cin7 Omni"""
        url = f"{self.base_url}/Quotes"
        
        # Transform line items for Cin7
        line_items = []
        for item in quote_data.line_items:
            line_items.append({
                "code": item.code,
                "name": item.name,
                "qty": float(item.qty),
                "unitPrice": float(item.unit_price) if item.unit_price else 0.0
            })
        
        # Build quote payload
        cin7_quote = {
            "firstName": quote_data.customer.first_name,
            "lastName": quote_data.customer.last_name,
            "company": quote_data.customer.business_name,
            "email": quote_data.customer.email,
            "phone": quote_data.customer.phone or "",
            "deliveryFirstName": quote_data.customer.first_name,
            "deliveryLastName": quote_data.customer.last_name,
            "deliveryCompany": quote_data.customer.business_name,
            "deliveryAddress1": quote_data.customer.address_line1,
            "deliveryAddress2": quote_data.customer.address_line2 or "",
            "deliveryCity": quote_data.customer.city,
            "deliveryState": quote_data.customer.state,
            "deliveryPostalCode": quote_data.customer.postal_code,
            "deliveryCountry": quote_data.customer.country,
            "stage": "New",
            "probability": 50.0,
            "lineItems": line_items,
            "reference": f"WEB-{datetime.now().strftime('%Y%m%d%H%M%S')}"
        }
        
        try:
            response = await http_client.client.post(
                url,
                headers=self.headers,
                json=[cin7_quote],  # Cin7 expects an array
                auth=self.auth
            )
            response.raise_for_status()
            data = response.json()
            
            # Cin7 returns an array, get the first item
            if isinstance(data, list) and len(data) > 0:
                return data[0]
            return data
            
        except Exception as e:
            logger.error(f"Error creating Cin7 quote: {str(e)}")
            raise HTTPException(status_code=500, detail=f"Failed to create Cin7 quote: {str(e)}")

# Initialize clients
shopify_client = ShopifyClient()
cin7_client = Cin7Client()

# API Routes
@app.get("/api/health")
async def health_check():
    """Health check endpoint"""
    return {
        "status": "healthy",
        "timestamp": datetime.utcnow().isoformat(),
        "service": "Quoting System API"
    }

@app.get("/api/products/{product_id}")
async def get_product(product_id: str):
    """Get product details from Shopify"""
    try:
        product = await shopify_client.get_product(product_id)
        return {"product": product}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/quotes", response_model=QuoteResponse)
async def create_quote(quote_request: QuoteRequest):
    """Create a new quote and submit to both Shopify and Cin7 Omni"""
    quote_id = str(uuid.uuid4())
    
    try:
        # Create quote record in MongoDB
        quote_record = {
            "_id": quote_id,
            "product_id": quote_request.product_id,
            "product_handle": quote_request.product_handle,
            "product_title": quote_request.product_title,
            "line_items": [item.dict() for item in quote_request.line_items],
            "customer": quote_request.customer.dict(),
            "discount_code": quote_request.discount_code,
            "notes": quote_request.notes,
            "status": "processing",
            "created_at": datetime.utcnow(),
            "shopify_draft_order_id": None,
            "cin7_quote_id": None,
            "errors": []
        }
        
        await database.quotes.insert_one(quote_record)
        
        # Create Shopify draft order
        shopify_draft_order = None
        shopify_error = None
        try:
            shopify_draft_order = await shopify_client.create_draft_order(quote_request)
            quote_record["shopify_draft_order_id"] = str(shopify_draft_order.get("id"))
            logger.info(f"Created Shopify draft order: {shopify_draft_order.get('id')}")
        except Exception as e:
            shopify_error = str(e)
            quote_record["errors"].append(f"Shopify error: {shopify_error}")
            logger.error(f"Shopify integration failed: {shopify_error}")
        
        # Create Cin7 Omni quote
        cin7_quote = None
        cin7_error = None
        try:
            cin7_quote = await cin7_client.create_quote(quote_request)
            quote_record["cin7_quote_id"] = str(cin7_quote.get("id"))
            logger.info(f"Created Cin7 quote: {cin7_quote.get('id')}")
        except Exception as e:
            cin7_error = str(e)
            quote_record["errors"].append(f"Cin7 error: {cin7_error}")
            logger.error(f"Cin7 integration failed: {cin7_error}")
        
        # Determine overall status
        if shopify_draft_order and cin7_quote:
            quote_record["status"] = "completed"
            message = "Quote successfully created in both Shopify and Cin7 Omni"
        elif shopify_draft_order or cin7_quote:
            quote_record["status"] = "partial"
            message = "Quote partially created. Check logs for details."
        else:
            quote_record["status"] = "failed"
            message = "Quote creation failed in both systems"
        
        # Update quote record
        await database.quotes.update_one(
            {"_id": quote_id},
            {"$set": quote_record}
        )
        
        return QuoteResponse(
            quote_id=quote_id,
            shopify_draft_order_id=quote_record.get("shopify_draft_order_id"),
            cin7_quote_id=quote_record.get("cin7_quote_id"),
            status=quote_record["status"],
            created_at=quote_record["created_at"],
            customer_name=f"{quote_request.customer.first_name} {quote_request.customer.last_name}",
            total_items=len(quote_request.line_items),
            message=message
        )
        
    except Exception as e:
        logger.error(f"Error creating quote: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to create quote: {str(e)}")

@app.get("/api/quotes/{quote_id}")
async def get_quote(quote_id: str):
    """Get quote details"""
    try:
        quote = await database.quotes.find_one({"_id": quote_id})
        if not quote:
            raise HTTPException(status_code=404, detail="Quote not found")
        
        # Convert MongoDB document to response format
        quote["quote_id"] = quote["_id"]
        del quote["_id"]
        
        return {"quote": quote}
    except Exception as e:
        logger.error(f"Error fetching quote {quote_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/quotes")
async def list_quotes():
    """List all quotes"""
    try:
        quotes = []
        async for quote in database.quotes.find().sort("created_at", -1):
            quote["quote_id"] = quote["_id"]
            del quote["_id"]
            quotes.append(quote)
        
        return {"quotes": quotes}
    except Exception as e:
        logger.error(f"Error listing quotes: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

# Shutdown event
@app.on_event("shutdown")
async def shutdown_event():
    await http_client.close()
    client.close()

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8001)