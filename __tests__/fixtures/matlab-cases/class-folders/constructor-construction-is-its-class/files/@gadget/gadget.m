function obj = gadget(n)
if nargin > 0
  other = gadget();
  tidy(other);
end
obj = class(struct('n', 0), 'gadget');
end
