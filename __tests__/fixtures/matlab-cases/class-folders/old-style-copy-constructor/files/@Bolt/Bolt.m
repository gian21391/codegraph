function s = Bolt(varargin)
if nargin == 1 && isa(varargin{1}, 'Bolt')
  s = varargin{1};
else
  s = class(struct('n', 0), 'Bolt');
end
tidy(s);
zt(1);
end
