function zkbw(h)
set(h, 'CloseRequestFcn', {'zkbwloc', 1});
set(h, 'CloseRequestFcn', 'zkbwloc2');
set(h, 'CloseRequestFcn', {'zkbwboth', 1});
set(h, 'CloseRequestFcn', {'zkbwpriv', 2});
set(h, 'CloseRequestFcn', 'zkbwpriv2');
set(h, 'CloseRequestFcn', {@zkbwhloc, 3});
set(h, 'CloseRequestFcn', {@zkbwhpriv, 3});
end
function zkbwloc(varargin)
end
function zkbwloc2(varargin)
end
function zkbwboth(varargin)
end
function zkbwhloc(varargin)
end
