classdef Pt
    properties
        x
    end
    methods
        function obj = Pt(x)
            obj.x = x;
        end
        d = magsq(obj)
    end
    methods (Static)
        p = origin()
    end
end
