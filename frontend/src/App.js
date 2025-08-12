import React, { useState, useEffect } from 'react';
import './App.css';

// Get backend URL from environment
const API_BASE_URL = process.env.REACT_APP_BACKEND_URL || 'http://localhost:8001';

function App() {
  const [currentView, setCurrentView] = useState('product-selection');
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [selectedVariants, setSelectedVariants] = useState([]);
  const [customerInfo, setCustomerInfo] = useState({
    first_name: '',
    last_name: '',
    email: '',
    business_name: '',
    phone: '',
    address_line1: '',
    address_line2: '',
    city: '',
    state: '',
    postal_code: '',
    country: 'Australia'
  });
  const [discountCode, setDiscountCode] = useState('');
  const [notes, setNotes] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitResult, setSubmitResult] = useState(null);
  const [loading, setLoading] = useState(false);

  // Sample product data (simulating Shopify product with variants)
  const sampleProduct = {
    id: '8708549009616',
    handle: 'k0604-rapid-no-atc',
    title: 'K0604 RAPID NO ATC - CO2 Laser Cutting Machine',
    description: 'Professional CO2 laser cutting machine for precision manufacturing',
    image: 'https://images.unsplash.com/photo-1581092918484-8313ea5dafeb?w=800&h=600&fit=crop',
    base_price: 45000,
    variants: [
      {
        id: 'var-1',
        code: 'K0604-BASE',
        name: 'Base Machine (No Add-ons)',
        price: 0,
        description: 'Standard K0604 RAPID without additional features'
      },
      {
        id: 'var-2', 
        code: 'K0604-ROTARY-BASIC',
        name: 'Rotary Device - Basic',
        price: 2500,
        description: 'Basic rotary attachment for cylindrical objects'
      },
      {
        id: 'var-3',
        code: 'K0604-ROTARY-PRO',
        name: 'Rotary Device - Professional',
        price: 4500,
        description: 'Professional rotary attachment with advanced features'
      },
      {
        id: 'var-4',
        code: 'K0604-AUTO-FOCUS',
        name: 'Auto Focus System',
        price: 3200,
        description: 'Automatic focusing system for improved precision'
      },
      {
        id: 'var-5',
        code: 'K0604-AIR-ASSIST',
        name: 'Air Assist System',
        price: 1800,
        description: 'Air assist for cleaner cuts and better results'
      },
      {
        id: 'var-6',
        code: 'K0604-EXHAUST-PRO',
        name: 'Professional Exhaust System',
        price: 2200,
        description: 'Industrial-grade exhaust and filtration system'
      },
      {
        id: 'var-7',
        code: 'K0604-CAMERA',
        name: 'Vision Camera System',
        price: 3800,
        description: 'Camera system for precise positioning and monitoring'
      },
      {
        id: 'var-8',
        code: 'K0604-CHILLER',
        name: 'Water Chiller Unit',
        price: 2800,
        description: 'Cooling system for extended operation'
      },
      {
        id: 'var-9',
        code: 'K0604-SOFTWARE-PRO',
        name: 'Professional Software Package',
        price: 1500,
        description: 'Advanced CAD/CAM software suite'
      },
      {
        id: 'var-10',
        code: 'K0604-WARRANTY-EXT',
        name: 'Extended Warranty (3 Years)',
        price: 3500,
        description: 'Extended warranty coverage and priority support'
      }
    ]
  };

  useEffect(() => {
    setSelectedProduct(sampleProduct);
  }, []);

  const handleVariantToggle = (variant) => {
    setSelectedVariants(prev => {
      const exists = prev.find(v => v.id === variant.id);
      if (exists) {
        return prev.filter(v => v.id !== variant.id);
      } else {
        return [...prev, { ...variant, qty: 1 }];
      }
    });
  };

  const handleQuantityChange = (variantId, qty) => {
    setSelectedVariants(prev => 
      prev.map(v => v.id === variantId ? { ...v, qty: parseInt(qty) || 1 } : v)
    );
  };

  const calculateTotal = () => {
    const basePrice = selectedProduct?.base_price || 0;
    const variantsTotal = selectedVariants.reduce((total, variant) => {
      return total + (variant.price * variant.qty);
    }, 0);
    return basePrice + variantsTotal;
  };

  const handleCustomerInfoChange = (field, value) => {
    setCustomerInfo(prev => ({
      ...prev,
      [field]: value
    }));
  };

  const handleSubmitQuote = async () => {
    if (!selectedProduct || selectedVariants.length === 0) {
      alert('Please select at least one variant');
      return;
    }

    // Validate required customer info
    const required = ['first_name', 'last_name', 'email', 'business_name', 'address_line1', 'city', 'state', 'postal_code'];
    for (const field of required) {
      if (!customerInfo[field]) {
        alert(`Please fill in ${field.replace('_', ' ')}`);
        return;
      }
    }

    setIsSubmitting(true);
    setSubmitResult(null);

    try {
      // Prepare line items
      const lineItems = selectedVariants.map(variant => ({
        code: variant.code,
        name: variant.name,
        qty: variant.qty,
        unit_price: variant.price
      }));

      const quoteData = {
        product_id: selectedProduct.id,
        product_handle: selectedProduct.handle,
        product_title: selectedProduct.title,
        line_items: lineItems,
        customer: customerInfo,
        discount_code: discountCode || null,
        notes: notes
      };

      const response = await fetch(`${API_BASE_URL}/api/quotes`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(quoteData)
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.detail || 'Failed to submit quote');
      }

      setSubmitResult(result);
      setCurrentView('success');

    } catch (error) {
      console.error('Error submitting quote:', error);
      setSubmitResult({
        success: false,
        message: error.message
      });
      setCurrentView('success');
    } finally {
      setIsSubmitting(false);
    }
  };

  const resetForm = () => {
    setCurrentView('product-selection');
    setSelectedVariants([]);
    setCustomerInfo({
      first_name: '',
      last_name: '',
      email: '',
      business_name: '',
      phone: '',
      address_line1: '',
      address_line2: '',
      city: '',
      state: '',
      postal_code: '',
      country: 'Australia'
    });
    setDiscountCode('');
    setNotes('');
    setSubmitResult(null);
  };

  return (
    <div className="app">
      <header className="app-header">
        <div className="container">
          <h1>Koenig Machinery - Get Your Quote</h1>
          <p>Configure your laser cutting machine and request a personalized quote</p>
        </div>
      </header>

      <main className="app-main">
        <div className="container">
          {currentView === 'product-selection' && (
            <div className="product-selection">
              {selectedProduct && (
                <>
                  <div className="product-info">
                    <div className="product-image">
                      <img src={selectedProduct.image} alt={selectedProduct.title} />
                    </div>
                    <div className="product-details">
                      <h2>{selectedProduct.title}</h2>
                      <p>{selectedProduct.description}</p>
                      <p className="base-price">Base Price: ${selectedProduct.base_price.toLocaleString()}</p>
                    </div>
                  </div>

                  <div className="variants-section">
                    <h3>Select Add-ons and Accessories</h3>
                    <p className="variants-subtitle">Choose up to 10 different add-ons to customize your machine</p>
                    
                    <div className="variants-grid">
                      {selectedProduct.variants.map(variant => (
                        <div 
                          key={variant.id} 
                          className={`variant-card ${selectedVariants.find(v => v.id === variant.id) ? 'selected' : ''}`}
                        >
                          <div className="variant-header">
                            <label className="variant-checkbox">
                              <input
                                type="checkbox"
                                checked={selectedVariants.some(v => v.id === variant.id)}
                                onChange={() => handleVariantToggle(variant)}
                              />
                              <span className="checkmark"></span>
                            </label>
                            <div className="variant-info">
                              <h4>{variant.name}</h4>
                              <p className="variant-price">
                                {variant.price > 0 ? `+$${variant.price.toLocaleString()}` : 'Included'}
                              </p>
                            </div>
                          </div>
                          <p className="variant-description">{variant.description}</p>
                          
                          {selectedVariants.find(v => v.id === variant.id) && (
                            <div className="quantity-control">
                              <label>Quantity:</label>
                              <input
                                type="number"
                                min="1"
                                max="10"
                                value={selectedVariants.find(v => v.id === variant.id)?.qty || 1}
                                onChange={(e) => handleQuantityChange(variant.id, e.target.value)}
                              />
                            </div>
                          )}
                        </div>
                      ))}
                    </div>

                    {selectedVariants.length > 0 && (
                      <div className="quote-summary">
                        <h3>Quote Summary</h3>
                        <div className="summary-items">
                          <div className="summary-item">
                            <span>Base Machine</span>
                            <span>${selectedProduct.base_price.toLocaleString()}</span>
                          </div>
                          {selectedVariants.map(variant => (
                            <div key={variant.id} className="summary-item">
                              <span>{variant.name} (x{variant.qty})</span>
                              <span>${(variant.price * variant.qty).toLocaleString()}</span>
                            </div>
                          ))}
                          <div className="summary-total">
                            <span>Total Estimated Price</span>
                            <span>${calculateTotal().toLocaleString()}</span>
                          </div>
                        </div>
                        
                        <button 
                          className="btn btn-primary btn-large"
                          onClick={() => setCurrentView('customer-info')}
                        >
                          Add to Quote
                        </button>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          )}

          {currentView === 'customer-info' && (
            <div className="customer-info-form">
              <div className="form-header">
                <h2>Your Information</h2>
                <p>Please provide your details to complete the quote request</p>
              </div>

              <form className="quote-form">
                <div className="form-section">
                  <h3>Contact Information</h3>
                  <div className="form-row">
                    <div className="form-group">
                      <label>First Name *</label>
                      <input
                        type="text"
                        value={customerInfo.first_name}
                        onChange={(e) => handleCustomerInfoChange('first_name', e.target.value)}
                        required
                      />
                    </div>
                    <div className="form-group">
                      <label>Last Name *</label>
                      <input
                        type="text"
                        value={customerInfo.last_name}
                        onChange={(e) => handleCustomerInfoChange('last_name', e.target.value)}
                        required
                      />
                    </div>
                  </div>
                  
                  <div className="form-row">
                    <div className="form-group">
                      <label>Email Address *</label>
                      <input
                        type="email"
                        value={customerInfo.email}
                        onChange={(e) => handleCustomerInfoChange('email', e.target.value)}
                        required
                      />
                    </div>
                    <div className="form-group">
                      <label>Phone Number</label>
                      <input
                        type="tel"
                        value={customerInfo.phone}
                        onChange={(e) => handleCustomerInfoChange('phone', e.target.value)}
                      />
                    </div>
                  </div>

                  <div className="form-group">
                    <label>Business Name *</label>
                    <input
                      type="text"
                      value={customerInfo.business_name}
                      onChange={(e) => handleCustomerInfoChange('business_name', e.target.value)}
                      required
                    />
                  </div>
                </div>

                <div className="form-section">
                  <h3>Address Information</h3>
                  <div className="form-group">
                    <label>Address Line 1 *</label>
                    <input
                      type="text"
                      value={customerInfo.address_line1}
                      onChange={(e) => handleCustomerInfoChange('address_line1', e.target.value)}
                      required
                    />
                  </div>
                  
                  <div className="form-group">
                    <label>Address Line 2</label>
                    <input
                      type="text"
                      value={customerInfo.address_line2}
                      onChange={(e) => handleCustomerInfoChange('address_line2', e.target.value)}
                    />
                  </div>

                  <div className="form-row">
                    <div className="form-group">
                      <label>City *</label>
                      <input
                        type="text"
                        value={customerInfo.city}
                        onChange={(e) => handleCustomerInfoChange('city', e.target.value)}
                        required
                      />
                    </div>
                    <div className="form-group">
                      <label>State *</label>
                      <input
                        type="text"
                        value={customerInfo.state}
                        onChange={(e) => handleCustomerInfoChange('state', e.target.value)}
                        required
                      />
                    </div>
                  </div>

                  <div className="form-row">
                    <div className="form-group">
                      <label>Postal Code *</label>
                      <input
                        type="text"
                        value={customerInfo.postal_code}
                        onChange={(e) => handleCustomerInfoChange('postal_code', e.target.value)}
                        required
                      />
                    </div>
                    <div className="form-group">
                      <label>Country</label>
                      <select
                        value={customerInfo.country}
                        onChange={(e) => handleCustomerInfoChange('country', e.target.value)}
                      >
                        <option value="Australia">Australia</option>
                        <option value="New Zealand">New Zealand</option>
                        <option value="Other">Other</option>
                      </select>
                    </div>
                  </div>
                </div>

                <div className="form-section">
                  <h3>Additional Information</h3>
                  <div className="form-group">
                    <label>Discount Code</label>
                    <input
                      type="text"
                      value={discountCode}
                      onChange={(e) => setDiscountCode(e.target.value)}
                      placeholder="Enter discount code if you have one"
                    />
                  </div>

                  <div className="form-group">
                    <label>Additional Notes</label>
                    <textarea
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                      rows="4"
                      placeholder="Any special requirements or questions..."
                    />
                  </div>
                </div>

                <div className="form-actions">
                  <button 
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => setCurrentView('product-selection')}
                  >
                    Back to Product
                  </button>
                  <button 
                    type="button"
                    className="btn btn-primary btn-large"
                    onClick={handleSubmitQuote}
                    disabled={isSubmitting}
                  >
                    {isSubmitting ? 'Submitting Quote...' : 'Submit Quote Request'}
                  </button>
                </div>
              </form>
            </div>
          )}

          {currentView === 'success' && (
            <div className="success-page">
              {submitResult && submitResult.status !== 'failed' ? (
                <div className="success-content">
                  <div className="success-icon">✓</div>
                  <h2>Quote Request Submitted Successfully!</h2>
                  <p>{submitResult.message}</p>
                  
                  <div className="quote-details">
                    <h3>Quote Details</h3>
                    <div className="detail-row">
                      <span>Quote ID:</span>
                      <span>{submitResult.quote_id}</span>
                    </div>
                    <div className="detail-row">
                      <span>Customer:</span>
                      <span>{submitResult.customer_name}</span>
                    </div>
                    <div className="detail-row">
                      <span>Total Items:</span>
                      <span>{submitResult.total_items}</span>
                    </div>
                    <div className="detail-row">
                      <span>Status:</span>
                      <span className={`status status-${submitResult.status}`}>
                        {submitResult.status}
                      </span>
                    </div>
                    {submitResult.shopify_draft_order_id && (
                      <div className="detail-row">
                        <span>Shopify Order ID:</span>
                        <span>{submitResult.shopify_draft_order_id}</span>
                      </div>
                    )}
                    {submitResult.cin7_quote_id && (
                      <div className="detail-row">
                        <span>Cin7 Quote ID:</span>
                        <span>{submitResult.cin7_quote_id}</span>
                      </div>
                    )}
                  </div>

                  <div className="next-steps">
                    <h3>What happens next?</h3>
                    <ul>
                      <li>Our sales team will review your quote within 24 hours</li>
                      <li>You'll receive a detailed proposal via email</li>
                      <li>We'll schedule a call to discuss your requirements</li>
                      <li>Final pricing and delivery timeline will be provided</li>
                    </ul>
                  </div>
                </div>
              ) : (
                <div className="error-content">
                  <div className="error-icon">⚠</div>
                  <h2>Quote Submission Failed</h2>
                  <p>{submitResult?.message || 'An error occurred while submitting your quote.'}</p>
                  <p>Please try again or contact our support team.</p>
                </div>
              )}

              <div className="success-actions">
                <button 
                  className="btn btn-primary"
                  onClick={resetForm}
                >
                  Create Another Quote
                </button>
              </div>
            </div>
          )}
        </div>
      </main>

      <footer className="app-footer">
        <div className="container">
          <p>&copy; 2024 Koenig Machinery. All rights reserved.</p>
        </div>
      </footer>
    </div>
  );
}

export default App;